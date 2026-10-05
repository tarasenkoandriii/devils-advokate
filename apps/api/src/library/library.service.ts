// Пункт 57: LibraryService (§3.5 ТЗ) — "Публичная библиотека разборов
// (Argument Marketplace)", пункт 36 v3-роадмапа, последний из семи
// ранее не начатых пунктов, найденных при аудите. По прямому запросу,
// логически зависел от Пункта 56 — публичная (не Telegram-
// аутентифицированная) поверхность API уже построена там, здесь
// расширяется новым публичным маршрутом (/public/library), не
// изобретается заново.
//
// SNAPSHOT-СЕМАНТИКА — LibraryArgument копирует ТЕКСТ аргументов
// проекта на момент отправки, не хранит живую ссылку на Argument (в
// отличие от PublicArgumentSubmission.promotedToArgumentId в Пункте
// 56, где связь именно живая и осмысленная). Здесь другая логика —
// опубликованная запись библиотеки должна быть стабильной, не
// меняться молча, если пользователь позже отредактирует аргументы в
// своём приватном проекте.
//
// isLibraryModerator — минимальный флаг на User (см. подробное
// обоснование над полем в schema.prisma) — НЕ self-service, не
// проверяется через какой-либо onboarding/regisration flow, только
// прямая ручная установка в БД тем, кто управляет деплойментом.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { insertUnderPublicWriteLimit } from '../common/public-write-limits';
import { PrismaService } from '../prisma/prisma.service';
import { mayBePublished } from '../common/fact-scope';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, LibraryModerationStatus, FactScope } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isUniqueViolation } from '../common/unique-violation';

/** Почему повторная отправка отклонена — ОДИН текст на оба пути.
 *
 * Пункт [own-submission] 2026-09-04 назвал настоящее состояние записи;
 * Пункт [check-then-create-2] 2026-09-27 сделал так, чтобы тот же текст
 * доставался и проигравшему гонку. Две копии формулировки разъехались бы
 * при первой правке, и одна из них стала бы неправдой.
 */
function alreadySubmitted(status: LibraryModerationStatus): BadRequestException {
  return new BadRequestException(
    status === LibraryModerationStatus.REJECTED
      ? 'Этот проект уже отправляли в библиотеку, и запись отклонили. Повторная отправка того же проекта не предусмотрена.'
      : status === LibraryModerationStatus.ACCEPTED
        ? 'Этот проект уже опубликован в библиотеке.'
        : 'Этот проект уже отправлен в библиотеку и ждёт решения модерации.',
  );
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ═══════════════════════ authenticated (TelegramAuthGuard) ═══════════════════════

  /** Копирует ТЕКСТ уже существующих общих (targetPersonId=null,
   * PRO/CON) аргументов проекта в снапшот — тот же фильтр, что уже
   * применялся в publicView() (Пункт 56)/OutcomeForecastingService
   * (Пункт 47): не адресные, не RECONCILIATION. */
  async submitProject(userId: string, projectId: string, title: string, category: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    if (!title.trim() || !category.trim()) {
      throw new BadRequestException('title и category обязательны');
    }

    // Пункт [own-submission] 2026-09-04: отказ повторной отправки был
    // прав, а его формулировка — нет. «Уже отправлен» человек читает как
    // «ждёт своей очереди», хотя запись могли и отклонить: в этом случае
    // он ждал бы решения, которое уже принято. Причина отказа теперь
    // называет настоящее состояние; повторная отправка отклонённого
    // по-прежнему не предусмотрена, и об этом сказано прямо, а не
    // умолчанием.
    const existing = await this.prisma.libraryEntry.findFirst({ where: { sourceProjectId: projectId } });
    if (existing) throw alreadySubmitted(existing.status);

    // Пункт [never-published-was-published] 2026-09-30: отбор шёл по
    // адресности и по знаку (`targetPersonId: null`, PRO/CON) и НЕ шёл
    // по происхождению. Аргумент, построенный из факта со
    // `scope = PRIVATE_TO_USER` («не публикуется ни при каких
    // обстоятельствах»), копировался в публичную библиотеку по тексту.
    // Поле `derivedFromPersonFactId` для этого и существует.
    const args = await this.prisma.argument.findMany({
      where: { projectId, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
      include: { derivedFromPersonFact: { select: { scope: true } } },
    });
    if (args.length === 0) {
      throw new BadRequestException('В проекте пока нет общих аргументов за/против — нечего отправлять в библиотеку');
    }
    const publishable = args.filter((a: { derivedFromPersonFact?: { scope: FactScope } | null }) => {
      const scope = a.derivedFromPersonFact?.scope;
      return scope === undefined || mayBePublished(scope);
    });
    const heldBack = args.length - publishable.length;
    if (publishable.length === 0) {
      throw new BadRequestException(
        'Все общие аргументы этого проекта построены из фактов, помеченных «не публикуется ни при каких обстоятельствах» — отправлять в библиотеку нечего.',
      );
    }

    // Пункт [check-then-create-2] 2026-09-27: `sourceProjectId` уникален,
    // и между проверкой выше и этой вставкой есть окно — двойное
    // нажатие давало P2002, то есть внутреннюю ошибку вместо того же
    // самого честного объяснения. Ответ обязан совпадать независимо от
    // того, кто успел раньше; текст берётся из ОДНОГО места, иначе две
    // формулировки разъедутся при первой же правке.
    let entry;
    try {
      entry = await this.prisma.libraryEntry.create({
        data: { title: title.trim(), category: category.trim(), sourceProjectId: projectId, submittedByUserId: userId },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.prisma.libraryEntry.findFirst({ where: { sourceProjectId: projectId } });
      // Запись успел создать параллельный вызов — сообщаем её состояние.
      // Если её вдруг нет (успели удалить), пробрасываем исходный отказ:
      // выдумывать состояние, которого не видели, нельзя.
      if (!winner) throw err;
      throw alreadySubmitted(winner.status);
    }
    await this.prisma.$transaction(
      publishable.map((a: { text: string; stance: string }) =>
        this.prisma.libraryArgument.create({ data: { libraryEntryId: entry.id, text: a.text, stance: a.stance as ArgumentStance } }),
      ),
    );
    // Пробел назван вслух: человек отправил проект и должен знать, что
    // ушло не всё и почему. Молчание здесь читалось бы как «ушло всё».
    return {
      ...entry,
      heldBackPrivateFacts: heldBack,
      heldBackNote:
        heldBack > 0
          ? `Не отправлено аргументов: ${heldBack}. Они построены из фактов, помеченных «не публикуется ни при каких обстоятельствах». Снять пометку можно у самого факта.`
          : null,
    };
  }

  /** Пункт [own-submission] 2026-09-04 — что человек может узнать о том,
   * что сам отправил.
   *
   * НАЙДЕНО: `submittedByUserId` записывался при создании и НЕ ЧИТАЛСЯ
   * НИГДЕ во всём проекте. Человек отдавал свой набор аргументов в
   * публичную библиотеку — и больше не мог узнать о нём ничего: ни
   * рассмотрен ли, ни принят, ни отклонён. Экран отправки при этом
   * утверждал «ожидает модерации или уже опубликован» — два исхода из
   * трёх, и отсутствующим был единственный плохой.
   *
   * Соседняя ветка продукта делает это правильно: публичное обсуждение
   * показывает участнику статус его заявки прямо словами. Правило было,
   * просто не везде.
   *
   * ПРИЧИНЫ ОТКЛОНЕНИЯ ЗДЕСЬ НЕТ, и это не забывчивость: модерация её не
   * записывает — колонки под неё в `LibraryEntry` не существует (см.
   * пункт [own-submission] в `TODO.md`). Экран говорит об этом прямо, а
   * не подставляет пустоту на место основания. */
  async listMySubmissions(userId: string) {
    return this.prisma.libraryEntry.findMany({
      where: { submittedByUserId: userId },
      select: {
        id: true,
        title: true,
        category: true,
        status: true,
        moderatedAt: true,
        createdAt: true,
        sourceProjectId: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPendingForModeration(userId: string) {
    await this.assertModerator(userId);
    return this.prisma.libraryEntry.findMany({
      where: { status: LibraryModerationStatus.PENDING },
      include: { arguments: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async moderate(userId: string, entryId: string, decision: 'ACCEPT' | 'REJECT') {
    await this.assertModerator(userId);
    const entry = await this.prisma.libraryEntry.findUnique({ where: { id: entryId } });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found`);
    }
    if (entry.status !== LibraryModerationStatus.PENDING) {
      throw new BadRequestException(`Эту запись уже рассмотрели (${entry.status}) — повторная модерация ничего не изменит`);
    }
    const updated = await this.prisma.libraryEntry.update({
      where: { id: entryId },
      data: {
        status: decision === 'ACCEPT' ? LibraryModerationStatus.ACCEPTED : LibraryModerationStatus.REJECTED,
        moderatedAt: new Date(),
      },
    });

    // Пункт [audit-log]
    await this.auditLog.record({
      actorId: userId,
      action: 'library_entry.moderated',
      resource: 'LibraryEntry',
      resourceId: entryId,
      before: { status: entry.status },
      after: { status: updated.status },
    });

    return updated;
  }

  // ═══════════════════════ public (no auth) ═══════════════════════

  // Пункт [badge-was-the-key] 2026-09-24. Сверка 2026-09-06 нашла
  // «строку целиком» на публичной витрине заведений и записала вывод
  // про ИЗМЕРЕНИЕ: считать чувствительным надо не по названию поля, а
  // по ПОВЕРХНОСТИ — что уходит туда, где нет аутентификации.
  // Публичных поверхностей три; вывод применили к одной.
  //
  // Здесь наружу уходило:
  //  • `submittedByUserId` — внутренний идентификатор реального
  //    пользователя, на эндпоинте без аутентификации;
  //  • `sourceProjectId` — ссылка на ЧАСТНЫЙ проект, из которого разбор
  //    опубликован.
  // Экран не показывал ни того, ни другого.
  private static readonly PUBLIC_ENTRY_FIELDS = {
    id: true, title: true, category: true, status: true,
    upvotes: true, downvotes: true, createdAt: true, updatedAt: true,
  } as const;

  async browse(category?: string) {
    return this.prisma.libraryEntry.findMany({
      where: { status: LibraryModerationStatus.ACCEPTED, ...(category ? { category } : {}) },
      select: LibraryService.PUBLIC_ENTRY_FIELDS,
      orderBy: { upvotes: 'desc' },
    });
  }

  async getEntry(entryId: string) {
    const entry = await this.prisma.libraryEntry.findFirst({
      where: { id: entryId, status: LibraryModerationStatus.ACCEPTED },
      select: {
        ...LibraryService.PUBLIC_ENTRY_FIELDS,
        arguments: { select: { id: true, text: true, stance: true } },
        experiences: { select: { id: true, text: true, authorDisplayName: true, createdAt: true } },
      },
    });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found or not yet published`);
    }
    return entry;
  }

  /** Простой счётчик — см. честное ограничение (нет защиты от
   * повторного голосования) в шапке файла/schema.prisma. */
  async vote(entryId: string, direction: 'up' | 'down') {
    const entry = await this.prisma.libraryEntry.findFirst({ where: { id: entryId, status: LibraryModerationStatus.ACCEPTED }, select: { id: true } });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found or not yet published`);
    }
    // ПОВТОРНЫЙ АУДИТ 2026-08-30: было read-then-write
    // (`entry.upvotes + 1`) на ПУБЛИЧНОМ неаутентифицированном
    // эндпоинте — два одновременных голоса перезаписывали друг друга
    // (классический lost update), и на однопоточном моке это не
    // воспроизводится в принципе. { increment: 1 } делает инкремент
    // на стороне Postgres, где он атомарен.
    //
    // Плюс явная проверка direction: раньше ЛЮБОЕ значение, кроме
    // строки 'up', молча считалось голосом «против» — при отсутствии
    // ValidationPipe в проекте это означало, что опечатка клиента
    // тихо превращалась в противоположный голос.
    //
    // Пункт [outside-input] 2026-09-04: «при отсутствии ValidationPipe
    // в проекте» — больше не так. Пункт [validation] 2026-09-01 ввёл
    // глобальный ValidationPipe, а этот заход разметил DTO самого
    // маршрута; абзац выше оставлен как история находки. Проверка
    // здесь остаётся намеренно — сервис зовётся не только из
    // публичного контроллера.
    if (direction !== 'up' && direction !== 'down') {
      throw new BadRequestException(`direction должен быть 'up' или 'down', получено: ${String(direction)}`);
    }
    // Пункт [badge-was-the-key] 2026-09-24: голос возвращал СТРОКУ
    // ЦЕЛИКОМ — то есть `submittedByUserId` и `sourceProjectId` уходили
    // наружу и здесь, мимо суженного чтения витрины. Сужение выдачи,
    // сделанное в одном методе и не сделанное в соседнем, — та же
    // форма, ради которой эта сверка и написана.
    return this.prisma.libraryEntry.update({
      where: { id: entryId },
      data: direction === 'up' ? { upvotes: { increment: 1 } } : { downvotes: { increment: 1 } },
      select: LibraryService.PUBLIC_ENTRY_FIELDS,
    });
  }

  async addExperience(entryId: string, text: string, authorDisplayName?: string) {
    const entry = await this.prisma.libraryEntry.findFirst({ where: { id: entryId, status: LibraryModerationStatus.ACCEPTED }, select: { id: true } });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found or not yet published`);
    }
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    // Пункт [the-open-door-had-no-counter] 2026-09-30: библиотека
    // открыта всем, и под одним разбором можно было писать бесконечно.
    // Пункт [the-public-door-counted-then-crossed] 2026-10-05: счёт и
    // запись — одним событием под замком записи библиотеки.
    return insertUnderPublicWriteLimit(
      this.prisma,
      'experiences-per-entry',
      entryId,
      (tx) => tx.libraryExperience.count({ where: { libraryEntryId: entryId } }),
      (tx) =>
        tx.libraryExperience.create({
          data: { libraryEntryId: entryId, text: text.trim(), authorDisplayName: authorDisplayName?.trim() || null },
          select: { id: true, text: true, authorDisplayName: true, createdAt: true },
        }),
    );
  }

  private async assertModerator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isLibraryModerator: true } });
    if (!user?.isLibraryModerator) {
      throw new ForbiddenException('Требуется роль модератора библиотеки');
    }
  }
}
