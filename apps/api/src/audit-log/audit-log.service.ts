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

export interface RecordAuditInput {
  actorId?: string | null; // null — системна дія (pg_cron тощо), не тільки людина
  action: string; // "user.restricted" | "library_entry.moderated" | "venue_application.moderated" | "prompt_version.promoted"
  resource: string; // "User" | "LibraryEntry" | "VenueApplication" | "PromptVersion"
  resourceId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
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
    return this.prisma.auditLogEntry.findMany({
      where: {
        resource: filters.resource,
        resourceId: filters.resourceId,
        actorId: filters.actorId,
      },
      orderBy: { createdAt: 'desc' },
      take: 200, // жорсткий потілок, той самий принцип, що вже застосований у ProjectsService.list()
    });
  }

  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }
}
