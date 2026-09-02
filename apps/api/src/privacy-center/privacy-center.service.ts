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
import { createHash } from 'node:crypto';
import { ExternalArtifactsCleanupService } from '../common/external-artifacts/external-artifacts-cleanup.service';
import { AIJobStatus, Prisma } from '@prisma/client';

// 2026-08-31: резолв токена перенесён в common/blob-token.ts — Vercel
// сам создаёт переменную под именем BLOB_READ_WRITE_TOKEN (без
// префикса), см. объяснение там.

@Injectable()
export class PrivacyCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly externalArtifacts: ExternalArtifactsCleanupService,
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
   * Аудит 2026-09-02 (продолжение) — два пробела в шаге 1:
   * - транзитные аудиофайлы РАЗГОВОРОВ (Conversation.audioBlobPathname —
   *   файл ждёт расшифровку/паралингвистику) не удалялись вовсе: шаг 1
   *   знал только про доказательства ДТП. Каскад снимал строку, файл
   *   оставался в хранилище без ссылки — навсегда (сторожевая ищет по
   *   строкам, а строки уже нет);
   * - задачи распознавания В ПОЛЁТЕ (разговор в TRANSCRIBING, голосовая
   *   реплика PENDING/PROCESSING) оставались у провайдера на весь его
   *   retention: вебхук пришёл бы на удалённую сущность. Теперь они
   *   убираются у провайдера до каскада (best-effort).
   *
   * Что НЕ удаляется отсюда и честно перечислено в ответе:
   * - у STT-провайдеров после чтения результата транскрипт удаляется
   *   нами сразу (Пункт [stt-multi], аудит 2026-09-02); что остаётся —
   *   пустая запись задачи со статусом и метаданные по их политике;
   * - записи AuditLog (юридически обязаны сохраняться, ПД в них нет —
   *   before/after фильтруются при записи);
   * - команды/группы без владельца остаются (без членов). */
  async deleteAccount(userId: string, confirmation: string) {
    if (confirmation !== 'DELETE') {
      throw new BadRequestException('Для удаления аккаунта передайте confirmation: "DELETE"');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, telegramId: true } });
    if (!user) throw new NotFoundException('User not found');

    // 1) внешние артефакты — доказательства ДТП, транзитные аудиофайлы
    //    разговоров, задачи распознавания в полёте (см.
    //    ExternalArtifactsCleanupService; тот же сервис — у удаления проекта)
    const artifacts = await this.externalArtifacts.discardForUser(userId);
    const evidenceCount = artifacts.evidenceBlobs;
    const blobsDeleted = artifacts.evidenceDeleted;
    const blobsFailed = artifacts.evidenceFailed;

    // 2) аудит до удаления — без telegramId в открытом виде
    const telegramIdHash = createHash('sha256').update(user.telegramId).digest('hex').slice(0, 16);
    const counts = await this.countUserData(userId);
    await this.auditLog.record({
      actorId: null,
      action: 'user.deleted',
      resource: 'User',
      resourceId: userId,
      before: { telegramIdHash, ...counts, evidenceBlobs: evidenceCount, conversationAudioBlobs: artifacts.conversationAudioBlobs, sttJobsInFlight: artifacts.sttJobsDiscarded },
      after: { blobsDeleted, blobsFailed, sttJobsDiscarded: artifacts.sttJobsDiscarded },
    });

    // 3) каскад
    await this.prisma.user.delete({ where: { id: userId } });

    // 4) следы AI-вызовов (аудит 2026-09-02, продолжение). AIJob.requestUserId
    //    — не FK, каскад его не касается, и после удаления аккаунта в
    //    ai_jobs оставались: сериализованный запрос неисполненных джоб
    //    (pendingRequest — ТЕКСТ пользователя целиком), обрывки ответов
    //    провайдера (partialResult) и все выводы AI (ai_inferences.output
    //    — разбор ЕГО ситуации). Строки джоб остаются ради телеметрии
    //    (счёт по taskType/статусу — там нет содержимого), содержимое —
    //    нет. Порядок: ПОСЛЕ каскада — все ссылки на инференсы из сущностей
    //    пользователя уже сняты каскадом, оставшиеся связи объявлены
    //    SetNull/Cascade (проверено по схеме).
    const aiTraces = await this.scrubAiTraces(userId);

    return {
      deleted: true,
      removed: { ...counts, aiInferences: aiTraces.inferencesDeleted, aiJobsCancelled: aiTraces.jobsCancelled },
      externalArtifacts: {
        evidenceBlobs: evidenceCount,
        deleted: blobsDeleted,
        failed: blobsFailed,
        conversationAudioBlobs: artifacts.conversationAudioBlobs,
        sttJobsDiscarded: artifacts.sttJobsDiscarded,
      },
      notRemovedHere: [
        'Метаданные задач у STT-провайдеров (Soniox, AssemblyAI): текст транскриптов мы удаляем сразу после получения, задачи в полёте — при удалении аккаунта; остаются пустые записи задач по политике провайдера.',
        'Обезличенные записи AI-вызовов (тип задачи, статус, длительность) — для телеметрии; тексты запросов и ответов удалены.',
        'Фоновые AI-задачи, уже отправленные провайдеру (Gemini), у нас отменены и результат не сохраняется; у провайдера они завершаются по его политике.',
        'Журнал аудита — хранится без персональных данных.',
        'Команды рекрутеров и инвест-группы — остаются без вашего членства.',
      ],
    };
  }

  /** Содержимое AI-вызовов пользователя: выводы удаляются, неисполненные
   * джобы отменяются (воркер их больше не возьмёт: submitQueued/pollRunning
   * выбирают только QUEUED/RUNNING), сериализованные запросы и обрывки
   * ответов обнуляются. Строки джоб остаются — телеметрия без содержимого. */
  private async scrubAiTraces(userId: string) {
    const jobs = await this.prisma.aIJob.findMany({ where: { requestUserId: userId }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    if (jobIds.length === 0) return { inferencesDeleted: 0, jobsCancelled: 0 };

    const inferences = await this.prisma.aIInference.deleteMany({ where: { aiJobId: { in: jobIds } } });
    const cancelled = await this.prisma.aIJob.updateMany({
      where: { id: { in: jobIds }, status: { in: [AIJobStatus.QUEUED, AIJobStatus.RUNNING] } },
      data: { status: AIJobStatus.CANCELLED, completedAt: new Date(), partialResult: 'аккаунт удалён — задача отменена' },
    });
    await this.prisma.aIJob.updateMany({
      where: { id: { in: jobIds } },
      data: { pendingRequest: Prisma.DbNull },
    });
    await this.prisma.aIJob.updateMany({
      where: { id: { in: jobIds }, status: { not: AIJobStatus.CANCELLED } },
      data: { partialResult: null },
    });
    return { inferencesDeleted: inferences.count, jobsCancelled: cancelled.count };
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
  /** GDPR art. 15 — право на доступ.
   *
   * Аудит 2026-09-02 (продолжение): кнопка в TMA называется «Скачать все
   * мои данные», а выгрузка отдавала три коллекции (проекты с пятью
   * связями, персоны с фактами, согласия) — без разговоров и
   * транскриптов, без ответов квиза, спарринга, чатов по материалам,
   * заметок, обязательств, профилей кандидатов. То есть большая часть
   * того, что человек продиктовал продукту, в «все мои данные» не
   * попадала. Теперь — основные коллекции с содержимым, и рядом честный
   * список того, что НЕ входит и почему. Полнота проверяется тестом по
   * ключам ответа: новая коллекция без записи здесь — падение теста, а
   * не тихая неполнота. */
  async exportData(userId: string) {
    const [projects, people, consents, intakeSessions, candidateProfiles, mediaReviewQueues, safeShareActions] =
      await Promise.all([
        this.prisma.project.findMany({
          where: { ownerId: userId },
          include: {
            objective: true,
            boundaries: true,
            arguments: true,
            steelmanCases: true,
            scripts: true,
            conversations: {
              include: {
                participants: true,
                transcript: { include: { segments: { orderBy: { startMs: 'asc' } } } },
              },
            },
            sparringSessions: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
            workingMaterials: {
              include: {
                versions: true,
                chatSessions: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
              },
            },
            protectedNotes: true,
            commitments: true,
            agendas: true,
            scheduledConversations: true,
            motiveHypotheses: true,
            predictions: true,
            outcomeScenarios: true,
            protocols: true,
            closingMessages: true,
          },
        }),
        this.prisma.person.findMany({
          where: { createdByUserId: userId },
          include: { facts: true },
        }),
        this.prisma.consentRecord.findMany({ where: { userId } }),
        this.prisma.intakeSession.findMany({ where: { userId } }),
        this.prisma.candidateProfile.findMany({ where: { ownerUserId: userId } }),
        this.prisma.mediaReviewQueue.findMany({ where: { userId }, include: { items: true } }),
        this.prisma.safeShareAction.findMany({ where: { userId } }),
      ]);

    return {
      exportedAt: new Date().toISOString(),
      projects,
      people,
      consents,
      intakeSessions,
      candidateProfiles,
      mediaReviewQueues,
      safeShareActions,
      notIncluded: [
        'Аудиофайлы — не хранятся (транзит до расшифровки, затем удаляются).',
        'Обезличенные записи AI-вызовов (тип задачи, статус, длительность) — технической телеметрии без вашего текста.',
        'Журнал аудита — служебный, без персональных данных.',
        'Данные других участников команд и групп — не ваши.',
      ],
    };
  }
}
