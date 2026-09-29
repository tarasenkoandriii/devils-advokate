// Пункт [audit-log]: перший реальний споживач `AuditLogEntry` — модель
// існувала в схемі з чекпоинту 1, ніколи не мала жодного сервісу, що
// в неї пише (§ TODO.md, "Мёртвая схема Prisma"). Знайдено при аудиті
// TODO.md по прямому запросу — розблоковано появою реальної
// адміністративної поверхні (Пункт [admin-panel]): раніше в проекті
// не було жодної дії "оператор щось вирішив за іншого користувача",
// вартої структурованого аудиту, тепер є чотири.
//
// НАЙСИЛЬНІШИЙ доказ, що це не спекулятивне рішення — коментар,
// написаний ще при реалізації admin-panel, прямо в
// AdminUsersService.restrictUser(): "для истории решений есть
// отдельный AuditLogEntry-класс механизмов проекта, не это поле".
// Тобто намір зафіксувати рішення через AuditLogEntry вже існував,
// просто ніколи не був виконаний.

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { pagedList, takeWithProbe } from '../common/page';

export interface RecordAuditInput {
  actorId?: string | null; // null — системна дія (pg_cron тощо), не тільки людина
  action: string; // "user.restricted" | "library_entry.moderated" | "venue_application.moderated" | "prompt_version.promoted"
  resource: string; // "User" | "LibraryEntry" | "VenueApplication" | "PromptVersion"
  resourceId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
}

/** Пункт [audit-trail] 2026-09-04 — ключи `before`/`after`, в которых
 * лежит СВОБОДНЫЙ ТЕКСТ о человеке, а не структура решения. Список
 * ведётся поимённо, а не по эвристике «строка длиннее N»: статус,
 * идентификатор и версия — тоже строки, и их терять нельзя. Тест
 * сверяет этот список с тем, что сервисы реально кладут в журнал, —
 * иначе новый текстовый ключ появится молча, и обещание пользователю
 * снова разойдётся с делом. */
export const FREE_TEXT_AUDIT_KEYS = [
  'restrictedNote',
  'blockedNote',
  'frozenNote',
  'note',
  'reason',
] as const;

/** Действия, чьи записи вообще могут нести свободный текст. Фильтр по
 * ним держит выборку при удалении маленькой и предсказуемой — журнал
 * растёт вместе с продуктом, а удаление аккаунта не должно перебирать
 * его целиком. */
export const ACTIONS_WITH_FREE_TEXT = [
  'user.restricted',
  'user.unrestricted',
  'user.blocked',
  'user.unblocked',
  'project.frozen',
  'project.unfrozen',
  'candidate_consent.revoked_by_recruiter',
  'user.deleted.ai_scrub_failed',
] as const;

/** Маркер вместо удалённого текста: пустое поле и стёртое поле — разные
 * утверждения, и второе человек должен видеть как второе. */
export const SCRUBBED_MARKER = '[удалено вместе с аккаунтом]';

function stripFreeText(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, changed: false };
  const source = value as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = { ...source };
  for (const key of FREE_TEXT_AUDIT_KEYS) {
    // null означает «заметки и не было» — подменять его маркером значило
    // бы сообщать об удалении того, чего не существовало.
    if (key in source && typeof source[key] === 'string' && source[key] !== '') {
      result[key] = SCRUBBED_MARKER;
      changed = true;
    }
  }
  return { value: result, changed };
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Викликається зсередини сервісів, що вже самі перевірили права
   * оператора — цей метод сам жодних прав не перевіряє (не
   * write-ендпоінт, внутрішній виклик). */
  async record(input: RecordAuditInput) {
    return this.prisma.auditLogEntry.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId,
        before: input.before === undefined ? undefined : (input.before as any),
        after: input.after === undefined ? undefined : (input.after as any),
        requestId: input.requestId,
      },
    });
  }

  /** Читання — тільки оператор (той самий мінімальний `isOperator`-
   * прапорець, що вже застосований у чотирьох Admin-сервісах/PromptRegistryService). */
  async list(operatorUserId: string, filters: { resource?: string; resourceId?: string; actorId?: string } = {}) {
    await this.assertOperator(operatorUserId);
    // Сверка чтений без потолка 2026-09-04: потолок здесь стоял с самого
    // начала, но МОЛЧАЛ — оператор видел двести записей и не мог отличить
    // «их всего двести» от «их тысяча, показаны последние». Для журнала,
    // по которому разбирают жалобу, это хуже отсутствия потолка: решение
    // принимается по списку, который выглядит полным.
    const rows = await this.prisma.auditLogEntry.findMany({
      where: {
        resource: filters.resource,
        resourceId: filters.resourceId,
        actorId: filters.actorId,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: takeWithProbe(),
    });
    return pagedList(rows);
  }

  /** Пункт [audit-trail] 2026-09-04 — чистка свободного текста в записях
   * журнала при удалении аккаунта.
   *
   * НАЙДЕНО: отчёт об удалении аккаунта сообщал человеку «Журнал аудита —
   * хранится без персональных данных». Неправда сразу в трёх местах:
   * `actorId` каждой записи — его собственный идентификатор, `resourceId`
   * записей `user.restricted`/`user.blocked`/`user.deleted` — тоже он, а
   * `before`/`after` решений модератора несут СВОБОДНЫЙ ТЕКСТ о нём
   * (`restrictedNote`, `blockedNote`, а у отзыва согласия кандидата —
   * `note` до 500 символов). Каскад удаления пользователя этих строк не
   * касается: `actorId` намеренно не FK.
   *
   * ЧТО ДЕЛАЕТСЯ И ПОЧЕМУ НЕ БОЛЬШЕ. Журнал решений оператора ОБЯЗАН
   * пережить удаление аккаунта: это единственная запись о том, что
   * решение вообще принималось, то есть то, чем человек может оспорить
   * решение, принятое о нём. Удалить журнал целиком значило бы защитить
   * оператора, а не человека. Поэтому сохраняется СТРУКТУРА решения (что
   * произошло, когда, кто действовал, к чему относилось), а убирается
   * ФОРМУЛИРОВКА: заметка модератора нужна ему в момент решения, а не
   * после того, как человека в продукте больше нет. Тот же приём и та же
   * граница, что у `scrubAiTraces()`: след вызова остаётся, содержание —
   * нет.
   *
   * ЧЕСТНАЯ ГРАНИЦА, названная и в отчёте пользователю: `actorId` и
   * `resourceId` остаются. Обезличить их — потерять сам смысл журнала (по
   * ним находят все решения об одном человеке), а срок хранения — решение
   * владельца, не наше. */
  async scrubFreeTextForDeletedUser(userId: string): Promise<{ auditEntriesScrubbed: number }> {
    const entries = await this.prisma.auditLogEntry.findMany({
      where: {
        OR: [{ actorId: userId }, { resource: 'User', resourceId: userId }],
        action: { in: [...ACTIONS_WITH_FREE_TEXT] },
      },
      select: { id: true, before: true, after: true },
    });

    let auditEntriesScrubbed = 0;
    for (const entry of entries) {
      const before = stripFreeText(entry.before);
      const after = stripFreeText(entry.after);
      if (!before.changed && !after.changed) continue;
      await this.prisma.auditLogEntry.update({
        where: { id: entry.id },
        data: {
          before: before.changed ? (before.value as any) : undefined,
          after: after.changed ? (after.value as any) : undefined,
        },
      });
      auditEntriesScrubbed++;
    }
    return { auditEntriesScrubbed };
  }

  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }
}
