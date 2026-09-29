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
import { EXPORT_EXCLUSIONS, EXPORTED_USER_PROFILE_FIELDS, USER_EXPORT_EXCLUSIONS, USER_PROFILE_EXCLUSIONS } from './export-scope';
import { pagedList, takeWithProbe } from '../common/page';
import { AuditLogService } from '../audit-log/audit-log.service';
import { createHash } from 'node:crypto';
import { ExternalArtifactsCleanupService } from '../common/external-artifacts/external-artifacts-cleanup.service';
import { AIJobStatus, Prisma } from '@prisma/client';
import { describeDecision } from './decision-labels';
import { ACCOUNT_NOT_REMOVED_HERE, SCRUBBED_INPUT_HASH } from './deletion-report';
import { ownScopeIds, DECISIONS_OUT_OF_SCOPE } from './decision-scope';
import { thirdPartyLosses, THIRD_PARTY_LOSSES_NOTE } from './deletion-impact';

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
   * - записи журнала аудита. Пункт [audit-trail] 2026-09-04: здесь
   *   стояло «ПД в них нет — before/after фильтруются при записи».
   *   Никакой такой фильтрации не существовало: `record()` кладёт
   *   before/after как есть, и в них попадали заметки модератора о
   *   человеке. Свободный текст теперь вычищается ЗДЕСЬ, при удалении
   *   (шаг 5); идентификаторы (`actorId`, `resourceId`) остаются
   *   намеренно — без них журнал перестаёт быть тем, чем человек может
   *   оспорить принятое о нём решение;
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
    // Пункт [cascade-took-a-stranger] 2026-09-26: считаем ДО каскада —
    // после него считать нечего.
    const tookFromOthers = await thirdPartyLosses(this.prisma, userId);
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

    // 5) свободный текст в журнале аудита (Пункт [audit-trail]
    //    2026-09-04). Порядок — последним и вне транзакции намеренно:
    //    запись `user.deleted` шага 2 уже сделана, каскад уже прошёл, и
    //    сбой чистки не должен отменить само удаление. Если чистка не
    //    удалась, число в отчёте будет нулевым — это видно, в отличие от
    //    прежнего состояния, когда текст оставался и об этом ничего не
    //    говорилось.
    const auditScrub = await this.auditLog.scrubFreeTextForDeletedUser(userId);

    return {
      deleted: true,
      removed: {
        ...counts,
        aiInferences: aiTraces.inferencesDeleted,
        aiJobsCancelled: aiTraces.jobsCancelled,
        aiJobsAnonymised: aiTraces.jobsAnonymised,
        auditEntriesScrubbed: auditScrub.auditEntriesScrubbed,
      },
      externalArtifacts: {
        evidenceBlobs: evidenceCount,
        deleted: blobsDeleted,
        failed: blobsFailed,
        conversationAudioBlobs: artifacts.conversationAudioBlobs,
        sttJobsDiscarded: artifacts.sttJobsDiscarded,
      },
      notRemovedHere: [...ACCOUNT_NOT_REMOVED_HERE],
      // Что забрало у других — тем же списком, что человек видел до
      // решения. Молчание здесь читалось бы как «ни у кого ничего».
      tookFromOthers,
      tookFromOthersNote: THIRD_PARTY_LOSSES_NOTE,
    };
  }

  /** Содержимое AI-вызовов пользователя: выводы удаляются, неисполненные
   * джобы отменяются (воркер их больше не возьмёт: submitQueued/pollRunning
   * выбирают только QUEUED/RUNNING), сериализованные запросы и обрывки
   * ответов обнуляются, а сами строки ОБЕЗЛИЧИВАЮТСЯ — снимаются
   * `requestUserId`, `inputHash` и `externalInteractionId`. Строки
   * остаются: на них стои́т телеметрия по фиче, и в них после этого нет
   * ни содержимого, ни указания на человека. */
  private async scrubAiTraces(userId: string) {
    const jobs = await this.prisma.aIJob.findMany({ where: { requestUserId: userId }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    if (jobIds.length === 0) return { inferencesDeleted: 0, jobsCancelled: 0, jobsAnonymised: 0 };

    // Сверка «половины операции» 2026-09-04: четыре шага шли подряд, и
    // сбой между ними оставлял часть следов — например, инференсы уже
    // удалены, а `pendingRequest` (ТЕКСТ запроса пользователя целиком)
    // ещё на месте. Здесь это хуже обычной половины: пользователь к
    // этому моменту уже удалён каскадом (шаг 3), он не может ни
    // повторить удаление, ни увидеть, что оно не доделано. Поэтому одна
    // операция — либо все следы стёрты, либо ни одного и это видно.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const inferences = await tx.aIInference.deleteMany({ where: { aiJobId: { in: jobIds } } });
        const cancelled = await tx.aIJob.updateMany({
          where: { id: { in: jobIds }, status: { in: [AIJobStatus.QUEUED, AIJobStatus.RUNNING] } },
          data: { status: AIJobStatus.CANCELLED, completedAt: new Date(), partialResult: 'аккаунт удалён — задача отменена' },
        });
        await tx.aIJob.updateMany({
          where: { id: { in: jobIds } },
          data: { pendingRequest: Prisma.DbNull },
        });
        await tx.aIJob.updateMany({
          where: { id: { in: jobIds }, status: { not: AIJobStatus.CANCELLED } },
          data: { partialResult: null },
        });
        // Пункт [anonymised-was-not-anonymous] 2026-09-29. До этого шага
        // строка джобы оставалась ПРИВЯЗАННОЙ К ЧЕЛОВЕКУ, хотя отчёт
        // называл её обезличенной: `requestUserId` — его идентификатор,
        // `inputHash` — sha256 его запроса (по нему подтверждается, что
        // присылал именно он), `externalInteractionId` — ссылка на
        // задачу у провайдера. Удалять строку нельзя (на ней стои́т
        // телеметрия по фиче), поэтому снимается ровно то, чем она
        // указывает на человека, и остаётся то, чем считают: тип
        // задачи, статус, время, версия модели.
        const anonymised = await tx.aIJob.updateMany({
          where: { id: { in: jobIds } },
          data: {
            requestUserId: null,
            externalInteractionId: null,
            inputHash: SCRUBBED_INPUT_HASH,
          },
        });
        return {
          inferencesDeleted: inferences.count,
          jobsCancelled: cancelled.count,
          jobsAnonymised: anonymised.count,
        };
      });
    } catch (err) {
      // Аккаунта уже нет — пожаловаться некому. Запись в аудит с перечнем
      // джоб делает остаток ВИДИМЫМ оператору: молчаливо оставленные
      // тексты человека — худший исход именно здесь. Автоматического
      // повтора нет сознательно (нужна очередь и своя сторожевая); чего
      // нет, о том сказано в TODO.md, а не изображено работающим.
      await this.auditLog.record({
        actorId: null,
        action: 'user.deleted.ai_scrub_failed',
        resource: 'AIJob',
        resourceId: userId,
        after: { jobIds, reason: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
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
  /** Решения, принятые О ЧЕЛОВЕКЕ, — единственное место этого запроса.
   *
   * Пункт [right-with-no-door] 2026-09-25. Раздел существовал только
   * внутри выгрузки, то есть прочитать решения о себе человек мог, лишь
   * скачав JSON-файл — в приложении внутри Telegram, на телефоне. При
   * этом продукт сам говорит ему, что запись о решении «единственное
   * свидетельство того, что решение принималось, и то, чем его можно
   * оспорить». Право было названо, двери к нему не было.
   *
   * Заметка модератора не отбирается ПОИМЁННЫМ select и здесь: это его
   * рабочая формулировка, а не факт о человеке. Пробный потолок
   * (`takeWithProbe` + `pagedList`) — чтобы обрезанный список не
   * выглядел полным ни в файле, ни на экране. */
  /** Что удаление аккаунта заберёт у ДРУГИХ людей.
   *
   * Пункт [cascade-took-a-stranger] 2026-09-26. Один метод на два пути —
   * предупреждение до решения и отчёт после, — чтобы числа в них не
   * разошлись (урок пункта [screen-said-what-server-unsaid]). */
  thirdPartyLosses(userId: string) {
    return thirdPartyLosses(this.prisma, userId);
  }

  async readDecisions(userId: string) {
    // Пункт [door-opened-onto-a-corner] 2026-09-25: область журнала
    // описана реестром, а не выражением здесь. Прежняя версия отбирала
    // строки по `User` и `Project` — и дотягивалась до девяти
    // расшифрованных действий из тридцати четырёх. Остальные,
    // среди которых рассмотренная заявка, отозванное согласие и
    // отозванный оффер, на экран не попадали, а пустой раздел при этом
    // УТВЕРЖДАЛ, что решений не принималось.
    const [accountWhere, projectWhere, belongingsWhere] = await Promise.all([
      ownScopeIds(this.prisma, userId, 'account'),
      ownScopeIds(this.prisma, userId, 'project'),
      ownScopeIds(this.prisma, userId, 'belongings'),
    ]);

    // `select` и `orderBy` выписаны в каждом запросе, а не вынесены в
    // переменную: сверка [tie-is-random] сработала на первой версии, и
    // сработала справедливо — переменная прячет порядок от того, кто
    // читает запрос, а у среза с потолком порядок и есть единственная
    // гарантия, что «последние 200» — это одни и те же 200.
    //
    // Группа с пустым списком видов ДОЛЖНА давать пустой результат, а не
    // весь журнал: `OR: []` в Prisma не сужает ничего, поэтому запрос не
    // делается вовсе.
    const read = async (where: Array<{ resource: string; resourceId: { in: string[] } }>) =>
      where.length === 0
        ? []
        : this.prisma.auditLogEntry.findMany({
            where: { OR: where },
            select: { action: true, resource: true, resourceId: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: takeWithProbe(),
          });

    const [accountRows, projectRows, belongingsRows] = await Promise.all([
      read(accountWhere),
      read(projectWhere),
      read(belongingsWhere),
    ]);

    return {
      accountDecisions: pagedList(accountRows),
      projectDecisions: pagedList(projectRows),
      belongingsDecisions: pagedList(belongingsRows),
    };
  }

  async exportData(userId: string) {
    const [
      projects,
      people,
      consents,
      intakeSessions,
      candidateProfiles,
      mediaReviewQueues,
      safeShareActions,
      // Пункт [export-user-scope] 2026-09-06 — связи САМОГО аккаунта.
      // Реестр закрывал связи проекта и на том останавливался; из
      // шестнадцати связей User в выгрузке были семь.
      profile,
      libraryEntries,
      venueApplications,
      venueBookingConfirmations,
      sentCandidateShares,
      voicePrint,
    ] = await Promise.all([
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
            // Сверка экспорта 2026-09-04: из 42 связей проекта в выгрузку
            // попадали 19, и `notIncluded` про остальные 23 не говорил
            // ничего — человек получал файл, который выглядит полным.
            // Добавлено всё, что является содержанием его работы; что
            // осознанно не идёт и почему — в `export-scope.ts`, и это
            // теперь проверяется тестом против схемы.
            missingInformationChecks: true,
            archetypePerspectives: true,
            situationalQuotes: true,
            situationalAnecdotes: true,
            schedulerAdvice: true,
            breakingQuestionSets: true,
            termsSheets: true,
            clientBriefs: true,
            clientReports: true,
            employerDossiers: true,
            agencyEngagements: true,
            candidatePipelineStatuses: true,
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
        // Собственные ответы человека: город, страна, язык, религия,
        // режим приватности, настройки. Поля перечислены поимённо в
        // export-scope.ts — новое поле анкеты обязано попадать сюда
        // сознательно, а не само собой.
        this.prisma.user.findUnique({
          where: { id: userId },
          select: Object.fromEntries(EXPORTED_USER_PROFILE_FIELDS.map((f) => [f, true])) as never,
        }),
        this.prisma.libraryEntry.findMany({ where: { submittedByUserId: userId } }),
        this.prisma.venueApplication.findMany({ where: { submittedByUserId: userId } }),
        this.prisma.venueBookingConfirmation.findMany({ where: { confirmedByUserId: userId } }),
        // Журнал собственных передач: кому человек отдавал свои данные.
        // БЕЗ токенов — токен это действующий ключ к его же данным, и
        // класть его в файл, который человек может кому-то переслать,
        // значило бы раздать доступ вместе с выгрузкой.
        this.prisma.candidateShare.findMany({
          where: { sharedByUserId: userId },
          select: {
            id: true, createdAt: true, expiresAt: true, acceptedAt: true,
            acceptedIntoMode: true, revokedAt: true, visibleClauseIds: true,
            consentSource: true, consentTextVersion: true, sourceSheetId: true,
          },
        }),
        // Голосовой отпечаток: сам вектор НЕ отдаётся — см. причину в
        // notIncluded. Отдаётся то, что человеку осмысленно знать:
        // отпечаток существует, когда посчитан, какой размерности.
        this.prisma.voiceEmbedding.findUnique({
          where: { userId },
          select: { createdAt: true, updatedAt: true, dimension: true },
        }),
      ]);

    // Пункт [right-with-no-door] 2026-09-25: тот же метод, что отдаёт
    // решения ЭКРАНУ. Раньше запрос жил только здесь, и человек мог
    // прочитать решения о себе единственным способом — скачав JSON на
    // телефон. Два вызова одного метода вместо двух копий запроса:
    // разойтись им теперь негде (урок пункта
    // [screen-said-what-server-unsaid]).
    const {
      accountDecisions: decisionsPage,
      projectDecisions: projectDecisionsPage,
      belongingsDecisions: belongingsPage,
    } = await this.readDecisions(userId);

    return {
      exportedAt: new Date().toISOString(),
      profile,
      projects,
      people,
      consents,
      intakeSessions,
      candidateProfiles,
      mediaReviewQueues,
      safeShareActions,
      // Пункт [decisions-spoke-machine] 2026-09-25: к машинному имени
      // действия добавлена фраза на языке человека и то, КЕМ решение
      // принято. Само имя оставлено: по нему человек и поддержка
      // говорят об одной и той же записи.
      accountDecisions: decisionsPage.items.map(describeDecision),
      projectDecisions: projectDecisionsPage.items.map(describeDecision),
      // Пункт [door-opened-onto-a-corner] 2026-09-25: решения о том, что
      // человеку принадлежит, — рассмотренная заявка, отозванное
      // согласие на передачу его данных, отозванный оффер. Прежняя
      // область журнала кончалась на аккаунте и проектах, и этих
      // решений не было ни в файле, ни на экране.
      belongingsDecisions: belongingsPage.items.map(describeDecision),
      libraryEntries,
      venueApplications,
      venueBookingConfirmations,
      sentCandidateShares,
      voicePrint: voicePrint
        ? { ...voicePrint, note: 'Голосовой отпечаток посчитан и хранится. Сам вектор в файл не входит — почему, сказано ниже; удалить отпечаток можно в настройках приватности.' }
        : null,
      notIncluded: [
        'Аудиофайлы — не хранятся (транзит до расшифровки, затем удаляются).',
        'Обезличенные записи AI-вызовов (тип задачи, статус, длительность) — технической телеметрии без вашего текста.',
        // Пункт [audit-trail] 2026-09-04. Здесь стояло: «Журнал аудита —
        // служебный, без персональных данных». Неверно дважды: журнал
        // хранит решения, принятые именно об этом аккаунте, и это данные
        // о человеке, а не служебные. Теперь такие решения выгружаются
        // разделом `accountDecisions`, а не включённой остаётся ровно
        // одна часть — и она названа.
        'Свободные заметки модератора при решениях о вашем аккаунте: сами решения выгружены в разделе «accountDecisions», но рабочая формулировка оператора — его оценка, а не факт о вас, и в выгрузку не входит.',
        // Пункт [ceiling-hid-inside-a-total] 2026-09-24. Строка
        // появляется ТОЛЬКО когда решений действительно больше потолка:
        // подпись, стоящая всегда, не отвечает на вопрос «мне отдали
        // всё?» — ровно за это её и критикует шапка `common/page.ts`.
        // Выгрузка — единственное место, где полнота и есть смысл
        // файла, и молчаливый потолок здесь хуже, чем где-либо.
        // Пункт [decisions-spoke-machine] 2026-09-25: та же строка для
        // решений о проектах — и тоже только когда их действительно
        // больше потолка.
        ...(projectDecisionsPage.hasMore
          ? [
              `Решения о ваших проектах старше последних ${projectDecisionsPage.limit}: в разделе «projectDecisions» отдаются ${projectDecisionsPage.limit} самых недавних, и их больше. Запросите остальные через поддержку — файл не обрезается молча.`,
            ]
          : []),
        ...(decisionsPage.hasMore
          ? [
              `Решения о вашем аккаунте старше последних ${decisionsPage.limit}: в разделе «accountDecisions» отдаются ${decisionsPage.limit} самых недавних, и их больше. Запросите остальные через поддержку — файл не обрезается молча.`,
            ]
          : []),
        ...(belongingsPage.hasMore
          ? [
              `Решения о ваших записях старше последних ${belongingsPage.limit}: в разделе «belongingsDecisions» отдаются ${belongingsPage.limit} самых недавних, и их больше. Запросите остальные через поддержку — файл не обрезается молча.`,
            ]
          : []),
        // Пункт [door-opened-onto-a-corner] 2026-09-25: что в область
        // решений НЕ входит — названо поимённо, а не умолчано. Строка
        // стоит всегда, потому что отвечает не «сколько показано», а
        // «где граница»: она не зависит от объёма данных.
        `Не входят в разделы решений: ${DECISIONS_OUT_OF_SCOPE.map((s) => `${s.resource} — ${s.why}`).join('; ')}.`,
        'Записи журнала о ваших собственных действиях (что вы сделали в продукте) — они дублируют содержимое разделов выше и не добавляют к нему ничего.',
        'Данные других участников команд и групп — не ваши.',
        // Сверка экспорта 2026-09-04: раньше список кончался четырьмя
        // строками выше, а за ними молча оставались 23 вида данных.
        // Теперь каждое исключение названо и объяснено — реестр в
        // export-scope.ts, тест не даёт ему отстать от схемы.
        ...Object.values(EXPORT_EXCLUSIONS),
        // Пункт [export-user-scope] 2026-09-06 — исключения уровня
        // аккаунта. Раньше их не было вовсе: список говорил только о
        // связях проекта, и девять связей самого аккаунта — включая
        // голосовой отпечаток — не были ни выгружены, ни названы.
        'Сам вектор голосового отпечатка — 192 числа, по которым вас можно узнать по голосу. Вам они ничего не скажут, а в файле, который вы кому-то перешлёте, это действующий биометрический идентификатор. Факт, дата и размерность отпечатка в выгрузке есть, удаление — в настройках приватности.',
        'Ключи ваших ссылок-самошерингов — сами передачи в выгрузке есть (когда, кому, что было видно, отозвано ли), но ключ это действующий доступ к вашим данным, и в файл он не кладётся.',
        ...Object.values(USER_EXPORT_EXCLUSIONS),
        ...Object.values(USER_PROFILE_EXCLUSIONS),
      ],
    };
  }
}
