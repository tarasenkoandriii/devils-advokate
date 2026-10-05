// Пункт [prompt-framework]: PromptRegistryService
// (devils-advocate-prompt-framework-tz.md, §5.1) — закрывает разрыв,
// найденный аудитом кода перед написанием ТЗ: 35 сервисов по всему
// проекту уже читают PromptVersion по status=ACTIVE, но ни одного
// способа эту версию создать/активировать не существовало — только
// ручной SQL. Этот сервис — единственный способ записи в
// PromptVersion, намеренно узкий набор переходов (см. ниже), не
// произвольный PATCH статуса.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptVersionStatus } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { withScopeLock } from '../common/ceiling-lock';
import { activePromptVersion } from '../common/active-prompt-version';

/** Ключ замка на «ровно одна ACTIVE в этой группе промптов» — одно
 *  место, чтобы повышение и откат ждали друг друга. Разъехавшиеся
 *  ключи означали бы два замка и ту же гонку обратно. */
function promptActiveLockKey(promptId: string): string {
  return `prompt-active|${promptId}`;
}

@Injectable()
export class PromptRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // Тот же минимальный подход, что isLibraryModerator/isVenueModerator
  // (см. schema.prisma) — не self-service, не RBAC.
  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }

  async createDraft(userId: string, promptId: string, version: string, template: string, changelog?: string) {
    await this.assertOperator(userId);
    return this.prisma.promptVersion.create({
      data: { promptId, version, template, changelog, status: PromptVersionStatus.DRAFT },
    });
  }

  async listVersions(userId: string, promptId: string) {
    await this.assertOperator(userId);
    return this.prisma.promptVersion.findMany({
      where: { promptId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Пункт [the-first-row-was-whichever] 2026-10-05: оператор обязан
  // видеть ТУ ЖЕ строку, по которой отвечает продукт. Здесь стояла своя
  // копия запроса с `createdAt: 'desc'` — то есть при двух активных
  // версиях экран оператора и 41 потребитель могли сойтись на одной
  // строке только случайно. Теперь чтение одно на всех.
  async getActiveVersion(userId: string, promptId: string) {
    await this.assertOperator(userId);
    return activePromptVersion(this.prisma, promptId);
  }

  // "PATCH после testing запрещён намеренно — версия, уже прошедшая
  // (или проходящая) оценку, не должна тихо измениться под тем же id"
  // (ТЗ §5.1, буквально).
  async updateDraft(userId: string, id: string, data: { template?: string; changelog?: string }) {
    await this.assertOperator(userId);
    const version = await this.findOrThrow(id);
    if (version.status !== PromptVersionStatus.DRAFT) {
      throw new BadRequestException(
        `PromptVersion ${id} is not in DRAFT status (current: ${version.status}) — content edits require a new version`,
      );
    }
    return this.prisma.promptVersion.update({ where: { id }, data });
  }

  async promoteToTesting(userId: string, id: string) {
    await this.assertOperator(userId);
    const version = await this.findOrThrow(id);
    if (version.status !== PromptVersionStatus.DRAFT) {
      throw new BadRequestException(`Повысить до TESTING можно только черновик; сейчас версия в статусе ${version.status}`);
    }
    return this.prisma.promptVersion.update({ where: { id }, data: { status: PromptVersionStatus.TESTING } });
  }

  // "единственная операция, физически создающая PromptVersionStatus.ACTIVE"
  // (ТЗ §5.2, буквально) — требует passed ReleaseGate на последнем
  // EvaluationRun этой версии, иначе 403 с конкретной непройденной
  // метрикой (acceptance-тест §6.1 ТЗ).
  async promoteToActive(userId: string, id: string) {
    await this.assertOperator(userId);
    const version = await this.findOrThrow(id);
    if (version.status !== PromptVersionStatus.TESTING) {
      throw new BadRequestException(`Повысить до ACTIVE можно только версию в статусе TESTING; сейчас ${version.status}`);
    }

    const lastRun = await this.prisma.evaluationRun.findFirst({
      where: { promptVersionId: id, subjectType: 'PROMPT_VERSION' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: { releaseGate: true, results: { include: { evaluationMetric: true } } },
    });

    if (!lastRun) {
      throw new BadRequestException(`У этой версии нет ни одного прогона оценки — оценка обязательна, а не по желанию`);
    }
    if (!lastRun.releaseGate) {
      throw new BadRequestException(`Прогон оценки ещё не получил решения релизного гейта — он не завершён`);
    }
    if (!lastRun.releaseGate.passed) {
      const failedMetrics = lastRun.results.filter((r: any) => !r.passed).map((r: any) => `${r.evaluationMetric.name}=${r.value}`);
      throw new ForbiddenException(
        `ReleaseGate for EvaluationRun ${lastRun.id} did not pass — failed metrics: ${failedMetrics.join(', ') || 'unknown'}`,
      );
    }

    // Предыдущие ACTIVE-версии того же promptId переводятся в
    // DEPRECATED. Пункт [the-first-row-was-whichever] 2026-10-05 —
    // здесь было ДВА дефекта, и оба держались на одном обещании.
    //
    // ПЕРВЫЙ: обещание «ровно одна ACTIVE на promptId» (его прежний
    // текст стоял ровно на этом месте) не обеспечивалось ничем. Ни
    // уникального ограничения в базе, ни транзакции, ни блокировки:
    // чтение, снятие прежней и постановка новой были тремя отдельными
    // обращениями. Два одновременных повышения разных версий одного
    // промпта видели одну и ту же прежнюю активную, оба её снимали и
    // оба ставили себя — на выходе ДВЕ активных.
    //
    // ВТОРОЙ: снималась РОВНО ОДНА прежняя активная. Если их уже две
    // (а до появления этого сервиса версии активировали ручным SQL —
    // сказано в шапке файла, значит данные инварианта не несут),
    // повышение третьей снимало одну и оставляло две.
    //
    // Теперь это одно событие под замком по `promptId`, и снимаются
    // ВСЕ активные. Снятые названы в журнале списком: назвать одну
    // значило бы соврать оператору в том единственном месте, где он
    // потом будет разбираться.
    // Снятые версии собираются в переменную, а не возвращаются объектом
    // из замка: сторож `[computed-for-the-person-never-shown]` видит
    // ЛЮБОЙ `return {` в теле метода и считает его ключи ответом
    // человеку. Объект здесь был внутренним, но отличить их сторож не
    // может — а записывать в реестр ответов то, что ответом не
    // является, значило бы засорять реестр ради удобства кода.
    let previousActiveIds: string[] = [];
    const activated = await withScopeLock(this.prisma, promptActiveLockKey(version.promptId), async (tx) => {
      previousActiveIds = (
        await tx.promptVersion.findMany({
          where: { promptId: version.promptId, status: PromptVersionStatus.ACTIVE },
          select: { id: true },
        })
      ).map((v) => v.id);
      await tx.promptVersion.updateMany({
        where: { promptId: version.promptId, status: PromptVersionStatus.ACTIVE },
        data: { status: PromptVersionStatus.DEPRECATED },
      });
      return tx.promptVersion.update({ where: { id }, data: { status: PromptVersionStatus.ACTIVE } });
    });

    // Пункт [audit-log] — зміна активного промпту впливає на поведінку
    // AI для всього продукту одразу, найвпливовіша з чотирьох дій, що
    // тепер аудитуються.
    await this.auditLog.record({
      actorId: userId,
      action: 'prompt_version.promoted_to_active',
      resource: 'PromptVersion',
      resourceId: id,
      before: { status: version.status, previousActiveIds },
      after: { status: activated.status },
    });

    return activated;
  }

  // "Откат на предыдущую ACTIVE-версию тем же promptId — одна операция,
  // не восстановление из бэкапа" (implementation-ready.md §7, правило 4;
  // ТЗ §5.1).
  // Пункт [the-first-row-was-whichever] 2026-10-05 — откат это
  // АВАРИЙНЫЙ ТОРМОЗ, и он мог не сработать, отчитавшись об успехе.
  //
  // Было: `findFirst` без порядка брал ПРОИЗВОЛЬНУЮ из активных, метил
  // её `ROLLBACK`, а вторая оставалась активной. Хуже всего то, что
  // происходило дальше: все 41 потребителя читали активную версию с
  // `orderBy: { createdAt: 'desc' }`, то есть выбирали самую НОВУЮ по
  // созданию, — а откат возвращает в строй версию, созданную РАНЬШЕ.
  // Значит недобитая новая оставалась той, по которой продукт отвечает,
  // оператор получал успешный ответ и запись в журнале, и промпт,
  // который он только что откатил, продолжал работать.
  //
  // Теперь: одно событие под замком; в `ROLLBACK` уходят ВСЕ активные
  // (тормоз обязан останавливать, а не выбирать, что остановить); и
  // предыдущая выведенная выбирается `[updatedAt desc, id desc]` —
  // `updatedAt` не уникален, и без второго ключа ничья вернулась бы.
  async rollback(userId: string, promptId: string) {
    await this.assertOperator(userId);

    let rolledBackIds: string[] = [];
    const restored = await withScopeLock(this.prisma, promptActiveLockKey(promptId), async (tx) => {
      const actives = await tx.promptVersion.findMany({
        where: { promptId, status: PromptVersionStatus.ACTIVE },
        select: { id: true },
      });
      if (actives.length === 0) {
        throw new BadRequestException(`У этого промпта нет активной версии — откатывать не с чего`);
      }
      const previous = await tx.promptVersion.findFirst({
        where: { promptId, status: PromptVersionStatus.DEPRECATED },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      if (!previous) {
        throw new BadRequestException(`У этого промпта нет предыдущей выведенной версии — откатывать не к чему`);
      }
      await tx.promptVersion.updateMany({
        where: { promptId, status: PromptVersionStatus.ACTIVE },
        data: { status: PromptVersionStatus.ROLLBACK },
      });
      rolledBackIds = actives.map((v) => v.id);
      return tx.promptVersion.update({ where: { id: previous.id }, data: { status: PromptVersionStatus.ACTIVE } });
    });

    await this.auditLog.record({
      actorId: userId,
      action: 'prompt_version.rolled_back',
      resource: 'PromptVersion',
      resourceId: promptId,
      before: { activeIds: rolledBackIds },
      after: { activeId: restored.id },
    });

    return restored;
  }

  private async findOrThrow(id: string) {
    const version = await this.prisma.promptVersion.findUnique({ where: { id } });
    if (!version) {
      throw new NotFoundException(`PromptVersion ${id} not found`);
    }
    return version;
  }
}
