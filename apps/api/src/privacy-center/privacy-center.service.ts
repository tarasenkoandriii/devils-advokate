// MVP-фича 11: Центр приватности (§3.47 ТЗ, MVP-пункт 11) —
// "единая точка, откуда пользователь может понять и проконтролировать,
// какие данные о нём и о фигурантах хранятся, без необходимости искать
// настройку внутри каждой отдельной фичи".
//
// ЧЕСТНО про то, чего здесь НЕТ и почему: ТЗ §3.47 перечисляет 6
// секций, две из них физически невозможны на этом проходе —
// "журнал Safe Share" (фича 12, ещё не реализована) и "TTL настройки
// хранения" (RetentionClass как отдельная модель никогда не
// реализовывалась). "Управление персональными данными онбординга —
// вероисповедание, город" тоже отсутствует — это фича §3.24, не входит
// в 13 пунктов MVP. Не выдумываю плейсхолдеры для этих трёх секций —
// экран агрегирует ровно то, что реально существует.
//
// Реальная новая ценность этого прохода — не агрегация сама по себе,
// а deletePerson(): ДО этого прохода PersonsService умел только
// отвязать персону от ОДНОГО проекта (removePerson), не удалить
// данные о человеке по-настоящему, как того требует §3.9 "право на
// удаление данных о себе". Каскад подтверждён на уровне схемы
// (Person.facts/projectLinks/steelmanCases — onDelete: Cascade,
// ConversationScript.person — onDelete: SetNull), не оркестрируется
// вручную в этом сервисе.

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SecretsService } from '../secrets/secrets.service';
import { deleteBlob } from '../common/vercel-blob';
import { createHash } from 'node:crypto';

const BLOB_TOKEN_REF = 'VERCEL_BLOB_READ_WRITE_TOKEN';

@Injectable()
export class PrivacyCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly secrets: SecretsService,
  ) {}

  /** Аудит моделей БД 2026-08-30, §2.4 — право на удаление (GDPR art. 17).
   *
   * Порядок важен:
   * 1) внешние артефакты (Vercel Blob с доказательствами ДТП) — best-effort,
   *    ошибка удаления одного файла не должна оставлять аккаунт в БД;
   * 2) запись в AuditLog ДО удаления (после — actorId уже некому
   *    указывать; в записи только хеш telegramId, не сам id);
   * 3) prisma.user.delete — все 16 связей на User каскадные (проверено
   *    аудитом), включая профили кандидатов, созданные пользователем и
   *    расшаренные в команды (право на удаление сильнее удобства команды).
   *
   * Что НЕ удаляется отсюда и честно перечислено в ответе:
   * - копии транскриптов у STT-провайдера (AssemblyAI хранит по своей
   *   политике; у нас — только текст в БД, он удаляется);
   * - записи AuditLog (юридически обязаны сохраняться, ПД в них нет —
   *   before/after фильтруются при записи);
   * - команды/группы без владельца остаются (без членов). */
  async deleteAccount(userId: string, confirmation: string) {
    if (confirmation !== 'DELETE') {
      throw new BadRequestException('Для удаления аккаунта передайте confirmation: "DELETE"');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, telegramId: true } });
    if (!user) throw new NotFoundException('User not found');

    // 1) внешние артефакты
    const evidence = await this.prisma.dtpEvidenceItem.findMany({
      where: { config: { project: { ownerId: userId } } },
      select: { id: true, blobUrl: true },
    });
    let blobsDeleted = 0;
    let blobsFailed = 0;
    if (evidence.length > 0) {
      const token = await this.secrets.resolve(BLOB_TOKEN_REF).catch(() => null);
      for (const e of evidence) {
        if (!token) { blobsFailed++; continue; }
        try { await deleteBlob(token, e.blobUrl); blobsDeleted++; } catch { blobsFailed++; }
      }
    }

    // 2) аудит до удаления — без telegramId в открытом виде
    const telegramIdHash = createHash('sha256').update(user.telegramId).digest('hex').slice(0, 16);
    const counts = await this.countUserData(userId);
    await this.auditLog.record({
      actorId: null,
      action: 'user.deleted',
      resource: 'User',
      resourceId: userId,
      before: { telegramIdHash, ...counts, evidenceBlobs: evidence.length },
      after: { blobsDeleted, blobsFailed },
    });

    // 3) каскад
    await this.prisma.user.delete({ where: { id: userId } });

    return {
      deleted: true,
      removed: counts,
      externalArtifacts: { evidenceBlobs: evidence.length, deleted: blobsDeleted, failed: blobsFailed },
      notRemovedHere: [
        'Копии транскриптов у STT-провайдера (AssemblyAI) — по его политике хранения; у нас удалён текст.',
        'Журнал аудита — хранится без персональных данных.',
        'Команды рекрутеров и инвест-группы — остаются без вашего членства.',
      ],
    };
  }

  private async countUserData(userId: string) {
    const [projects, conversations, people, consents, intakeSessions, mediaQueues] = await Promise.all([
      this.prisma.project.count({ where: { ownerId: userId } }),
      this.prisma.conversation.count({ where: { project: { ownerId: userId } } }),
      this.prisma.person.count({ where: { createdByUserId: userId } }),
      this.prisma.consentRecord.count({ where: { userId } }),
      this.prisma.intakeSession.count({ where: { userId } }),
      this.prisma.mediaReviewQueue.count({ where: { userId } }),
    ]);
    return { projects, conversations, people, consents, intakeSessions, mediaQueues };
  }

  async getOverview(userId: string) {
    const [consents, projectsCount, people] = await Promise.all([
      this.prisma.consentRecord.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.project.count({ where: { ownerId: userId } }),
      this.prisma.person.findMany({
        where: { createdByUserId: userId },
        include: { _count: { select: { facts: true, projectLinks: true } } },
      }),
    ]);

    return {
      consents,
      projectsCount,
      people: people.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        factsCount: p._count.facts,
        projectsCount: p._count.projectLinks,
      })),
    };
  }

  /** Полное, необратимое удаление персоны и всех данных о ней —
   * не путать с PersonsService.removePerson(), который только
   * отвязывает персону от ОДНОГО проекта. Закрывает §3.9
   * "право на удаление данных о себе" по-настоящему. */
  async deletePerson(userId: string, personId: string): Promise<void> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, createdByUserId: userId },
    });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    await this.prisma.person.delete({ where: { id: personId } });
  }

  /** Экспорт данных пользователя. Возвращает JSON напрямую, не
   * ссылку на скачивание ({downloadUrl}) — implementation-ready
   * описывал асинхронный джоб с генерацией файла, но это требует
   * файлового хранилища, которого нет в этом MVP-проходе. Осознанное
   * упрощение для объёма данных одного пользователя на старте продукта. */
  async exportData(userId: string) {
    const [projects, people, consents] = await Promise.all([
      this.prisma.project.findMany({
        where: { ownerId: userId },
        include: {
          objective: true,
          boundaries: true,
          arguments: true,
          steelmanCases: true,
          scripts: true,
        },
      }),
      this.prisma.person.findMany({
        where: { createdByUserId: userId },
        include: { facts: true },
      }),
      this.prisma.consentRecord.findMany({ where: { userId } }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      projects,
      people,
      consents,
    };
  }
}
