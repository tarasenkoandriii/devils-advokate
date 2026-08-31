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

  async getActiveVersion(userId: string, promptId: string) {
    await this.assertOperator(userId);
    return this.prisma.promptVersion.findFirst({
      where: { promptId, status: PromptVersionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
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
      throw new BadRequestException(`PromptVersion ${id} must be DRAFT to promote to TESTING (current: ${version.status})`);
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
      throw new BadRequestException(`PromptVersion ${id} must be TESTING to promote to ACTIVE (current: ${version.status})`);
    }

    const lastRun = await this.prisma.evaluationRun.findFirst({
      where: { promptVersionId: id, subjectType: 'PROMPT_VERSION' },
      orderBy: { startedAt: 'desc' },
      include: { releaseGate: true, results: { include: { evaluationMetric: true } } },
    });

    if (!lastRun) {
      throw new BadRequestException(`PromptVersion ${id} has no EvaluationRun — evaluation is required, not optional`);
    }
    if (!lastRun.releaseGate) {
      throw new BadRequestException(`EvaluationRun ${lastRun.id} has no ReleaseGate decision yet — run is not complete`);
    }
    if (!lastRun.releaseGate.passed) {
      const failedMetrics = lastRun.results.filter((r: any) => !r.passed).map((r: any) => `${r.evaluationMetric.name}=${r.value}`);
      throw new ForbiddenException(
        `ReleaseGate for EvaluationRun ${lastRun.id} did not pass — failed metrics: ${failedMetrics.join(', ') || 'unknown'}`,
      );
    }

    // Предыдущая ACTIVE-версия того же promptId переводится в
    // DEPRECATED — ровно одна ACTIVE на promptId одновременно (35
    // потребителей запрашивают "активную версию", не список).
    const previousActive = await this.prisma.promptVersion.findFirst({
      where: { promptId: version.promptId, status: PromptVersionStatus.ACTIVE },
    });
    if (previousActive) {
      await this.prisma.promptVersion.update({
        where: { id: previousActive.id },
        data: { status: PromptVersionStatus.DEPRECATED },
      });
    }

    const activated = await this.prisma.promptVersion.update({ where: { id }, data: { status: PromptVersionStatus.ACTIVE } });

    // Пункт [audit-log] — зміна активного промпту впливає на поведінку
    // AI для всього продукту одразу, найвпливовіша з чотирьох дій, що
    // тепер аудитуються.
    await this.auditLog.record({
      actorId: userId,
      action: 'prompt_version.promoted_to_active',
      resource: 'PromptVersion',
      resourceId: id,
      before: { status: version.status, previousActiveId: previousActive?.id ?? null },
      after: { status: activated.status },
    });

    return activated;
  }

  // "Откат на предыдущую ACTIVE-версию тем же promptId — одна операция,
  // не восстановление из бэкапа" (implementation-ready.md §7, правило 4;
  // ТЗ §5.1).
  async rollback(userId: string, promptId: string) {
    await this.assertOperator(userId);
    const current = await this.prisma.promptVersion.findFirst({
      where: { promptId, status: PromptVersionStatus.ACTIVE },
    });
    if (!current) {
      throw new BadRequestException(`No ACTIVE PromptVersion for promptId=${promptId} to roll back from`);
    }
    const previous = await this.prisma.promptVersion.findFirst({
      where: { promptId, status: PromptVersionStatus.DEPRECATED },
      orderBy: { updatedAt: 'desc' },
    });
    if (!previous) {
      throw new BadRequestException(`No previous DEPRECATED PromptVersion for promptId=${promptId} to roll back to`);
    }

    await this.prisma.promptVersion.update({ where: { id: current.id }, data: { status: PromptVersionStatus.ROLLBACK } });
    const restored = await this.prisma.promptVersion.update({ where: { id: previous.id }, data: { status: PromptVersionStatus.ACTIVE } });

    await this.auditLog.record({
      actorId: userId,
      action: 'prompt_version.rolled_back',
      resource: 'PromptVersion',
      resourceId: promptId,
      before: { activeId: current.id },
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
