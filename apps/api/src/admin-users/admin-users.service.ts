// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.3, §8
// юридического чек-листа п.11) — единственный пункт из 15 в чек-листе,
// требующий ручного административного действия: "модерация вправе
// ограничить аккаунт при аномальном паттерне". Намеренно минимальная
// реализация — bool-флаг, не готовая RBAC/степени ограничения (см.
// комментарий над isRestricted в schema.prisma).

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

export interface AdminUserRow {
  id: string;
  telegramId: string;
  createdAt: Date;
  isRestricted: boolean;
  isBlocked: boolean;
  isLibraryModerator: boolean;
  isVenueModerator: boolean;
  isOperator: boolean;
}

export interface AdminUserDetail extends AdminUserRow {
  restrictedAt: Date | null;
  restrictedNote: string | null;
  blockedAt: Date | null;
  blockedNote: string | null;
  projectCount: number;
  conversationCount: number;
  lastActivityAt: Date | null;
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // Тот же минимальный подход, что уже применён в PromptRegistryService/
  // EvaluationService/CalibrationService/TelemetryService.
  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }

  async listUsers(operatorUserId: string, search?: string, restricted?: boolean, blocked?: boolean): Promise<AdminUserRow[]> {
    await this.assertOperator(operatorUserId);

    const where: any = {};
    if (search) where.telegramId = { contains: search };
    if (restricted !== undefined) where.isRestricted = restricted;
    if (blocked !== undefined) where.isBlocked = blocked;

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        telegramId: true,
        createdAt: true,
        isRestricted: true,
        isBlocked: true,
        isLibraryModerator: true,
        isVenueModerator: true,
        isOperator: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return users;
  }

  async getUserDetail(operatorUserId: string, targetUserId: string): Promise<AdminUserDetail> {
    await this.assertOperator(operatorUserId);

    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    const projectCount = await this.prisma.project.count({ where: { ownerId: targetUserId } });
    const conversationCount = await this.prisma.conversation.count({
      where: { project: { ownerId: targetUserId } },
    });

    // Последняя активность — приближённо, по самой свежей из трёх
    // временных меток, которые у нас реально есть (не заводим
    // отдельного трекинга "последний visit", которого в проекте нет
    // вообще — честная оценка на существующих данных, не точный лог).
    const lastProject = await this.prisma.project.findFirst({
      where: { ownerId: targetUserId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const lastConversation = await this.prisma.conversation.findFirst({
      where: { project: { ownerId: targetUserId } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const candidates = [user.createdAt, lastProject?.createdAt, lastConversation?.createdAt].filter(
      (d): d is Date => d != null,
    );
    const lastActivityAt = candidates.length > 0 ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;

    return {
      id: user.id,
      telegramId: user.telegramId,
      createdAt: user.createdAt,
      isRestricted: user.isRestricted,
      isBlocked: user.isBlocked,
      isLibraryModerator: user.isLibraryModerator,
      isVenueModerator: user.isVenueModerator,
      isOperator: user.isOperator,
      restrictedAt: user.restrictedAt,
      restrictedNote: user.restrictedNote,
      blockedAt: user.blockedAt,
      blockedNote: user.blockedNote,
      projectCount,
      conversationCount,
      lastActivityAt,
    };
  }

  async restrictUser(operatorUserId: string, targetUserId: string, restricted: boolean, note?: string) {
    await this.assertOperator(operatorUserId);

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: restricted
        ? { isRestricted: true, restrictedAt: new Date(), restrictedNote: note ?? null }
        : { isRestricted: false, restrictedAt: null, restrictedNote: null },
    });

    // Пункт [audit-log] — закриває розрив, на який сам старий
    // коментар цього методу посилався ("для истории решений есть
    // отдельный AuditLogEntry-класс механизмов проекта"), але ніколи
    // не викликав. before/after — тільки поля, що змінились, не весь
    // об'єкт User (уникнення випадкового витоку чутливих полів у
    // журнал, якщо User колись отримає такі поля).
    await this.auditLog.record({
      actorId: operatorUserId,
      action: restricted ? 'user.restricted' : 'user.unrestricted',
      resource: 'User',
      resourceId: targetUserId,
      before: { isRestricted: target.isRestricted, restrictedNote: target.restrictedNote },
      after: { isRestricted: updated.isRestricted, restrictedNote: updated.restrictedNote },
    });

    return updated;
  }

  /** Пункт [full-block] — друга, жорсткіша ступінь, незалежна від
   * restrictUser вище. blockUser не чіпає isRestricted, і навпаки —
   * оператор може зняти isRestricted, лишивши isBlocked=true, або
   * навпаки, той самий принцип "різні прапорці, різне судження", що
   * вже застосований до isLibraryModerator/isVenueModerator/isOperator.
   *
   * АУДИТ (знайдено при перевірці UI): захист від self-lockout —
   * isBlocked відхиляє вхід ЦІЛКОМ (TelegramAuthGuard/AdminAuthService),
   * тож оператор, що заблокує сам себе, втратить доступ до адмінки
   * назавжди без жодного шляху розблокувати назад (особливо критично
   * для соло-масштаба проєкту з одним оператором — немає кому
   * попросити). restrictUser НЕ потребує того самого захисту —
   * isRestricted не блокує вхід, самообмеження лишається відновним. */
  async blockUser(operatorUserId: string, targetUserId: string, blocked: boolean, note?: string) {
    await this.assertOperator(operatorUserId);

    if (blocked && operatorUserId === targetUserId) {
      throw new ForbiddenException('Нельзя заблокировать собственный аккаунт — это привело бы к потере доступа без возможности восстановления');
    }

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: blocked
        ? { isBlocked: true, blockedAt: new Date(), blockedNote: note ?? null }
        : { isBlocked: false, blockedAt: null, blockedNote: null },
    });

    // ПОВТОРНЫЙ АУДИТ 2026-08-30: блокировка выставляла флаг, но не
    // трогала уже выданные AdminSession, а AdminSessionGuard проверял
    // только срок жизни токена. TelegramAuthGuard заблокированного
    // действительно отсекал — а cookie админки продолжала работать до
    // семи суток, то есть блокировка закрывала обычный интерфейс и
    // оставляла открытым самый опасный. Guard теперь тоже проверяет
    // isBlocked (fail closed на каждый запрос), но и сессии удаляются
    // сразу: блокировка должна действовать мгновенно, а не «когда
    // guard в следующий раз посмотрит».
    if (blocked) {
      await this.prisma.adminSession.deleteMany({ where: { userId: targetUserId } });
    }

    await this.auditLog.record({
      actorId: operatorUserId,
      action: blocked ? 'user.blocked' : 'user.unblocked',
      resource: 'User',
      resourceId: targetUserId,
      before: { isBlocked: target.isBlocked, blockedNote: target.blockedNote },
      after: { isBlocked: updated.isBlocked, blockedNote: updated.blockedNote },
    });

    return updated;
  }
}
