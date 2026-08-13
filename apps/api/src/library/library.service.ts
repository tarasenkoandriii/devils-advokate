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
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, LibraryModerationStatus } from '@prisma/client';

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════ authenticated (TelegramAuthGuard) ═══════════════════════

  /** Копирует ТЕКСТ уже существующих общих (targetPersonId=null,
   * PRO/CON) аргументов проекта в снапшот — тот же фильтр, что уже
   * применялся в publicView() (Пункт 56)/OutcomeForecastingService
   * (Пункт 47): не адресные, не RECONCILIATION. */
  async submitProject(userId: string, projectId: string, title: string, category: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    if (!title.trim() || !category.trim()) {
      throw new BadRequestException('title и category обязательны');
    }

    const existing = await this.prisma.libraryEntry.findFirst({ where: { sourceProjectId: projectId } });
    if (existing) {
      throw new BadRequestException(`Проект ${projectId} уже отправлен в библиотеку (запись ${existing.id})`);
    }

    const args = await this.prisma.argument.findMany({
      where: { projectId, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
    });
    if (args.length === 0) {
      throw new BadRequestException('В проекте пока нет общих аргументов за/против — нечего отправлять в библиотеку');
    }

    const entry = await this.prisma.libraryEntry.create({
      data: { title: title.trim(), category: category.trim(), sourceProjectId: projectId, submittedByUserId: userId },
    });
    await this.prisma.$transaction(
      args.map((a: { text: string; stance: string }) =>
        this.prisma.libraryArgument.create({ data: { libraryEntryId: entry.id, text: a.text, stance: a.stance as ArgumentStance } }),
      ),
    );
    return entry;
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
      throw new BadRequestException(`LibraryEntry ${entryId} already moderated (status=${entry.status})`);
    }
    return this.prisma.libraryEntry.update({
      where: { id: entryId },
      data: {
        status: decision === 'ACCEPT' ? LibraryModerationStatus.ACCEPTED : LibraryModerationStatus.REJECTED,
        moderatedAt: new Date(),
      },
    });
  }

  // ═══════════════════════ public (no auth) ═══════════════════════

  async browse(category?: string) {
    return this.prisma.libraryEntry.findMany({
      where: { status: LibraryModerationStatus.ACCEPTED, ...(category ? { category } : {}) },
      orderBy: { upvotes: 'desc' },
    });
  }

  async getEntry(entryId: string) {
    const entry = await this.prisma.libraryEntry.findFirst({
      where: { id: entryId, status: LibraryModerationStatus.ACCEPTED },
      include: { arguments: true, experiences: true },
    });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found or not yet published`);
    }
    return entry;
  }

  /** Простой счётчик — см. честное ограничение (нет защиты от
   * повторного голосования) в шапке файла/schema.prisma. */
  async vote(entryId: string, direction: 'up' | 'down') {
    const entry = await this.prisma.libraryEntry.findFirst({ where: { id: entryId, status: LibraryModerationStatus.ACCEPTED } });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found or not yet published`);
    }
    return this.prisma.libraryEntry.update({
      where: { id: entryId },
      data: direction === 'up' ? { upvotes: entry.upvotes + 1 } : { downvotes: entry.downvotes + 1 },
    });
  }

  async addExperience(entryId: string, text: string, authorDisplayName?: string) {
    const entry = await this.prisma.libraryEntry.findFirst({ where: { id: entryId, status: LibraryModerationStatus.ACCEPTED } });
    if (!entry) {
      throw new NotFoundException(`LibraryEntry ${entryId} not found or not yet published`);
    }
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    return this.prisma.libraryExperience.create({
      data: { libraryEntryId: entryId, text: text.trim(), authorDisplayName: authorDisplayName?.trim() || null },
    });
  }

  private async assertModerator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isLibraryModerator: true } });
    if (!user?.isLibraryModerator) {
      throw new ForbiddenException('Требуется роль модератора библиотеки');
    }
  }
}
