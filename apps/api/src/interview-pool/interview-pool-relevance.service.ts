// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.3/§4.4):
// порівняльне ранжування по всьому пулу — "радник, не суддя"
// реалізовано технічно тут, не тільки продекларовано (§2.3 ТЗ).

import { BadRequestException, Injectable, NotFoundException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hasPersonVerdict } from '../common/no-person-verdict';
import { isMissingColumnError, warnMigrationLagOnce, migrationLagAt } from '../common/enum-migration-lag';
import { numberedTranscript, resolveSegmentRef } from '../common/transcript-prompt';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { CandidateStage, ClauseCoverage, EvidenceKind, TermsClauseKind, TermsSide } from '@prisma/client';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';
import { consentRevoked } from './consent-revocation';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { allFilled, allStringsFilled, itemFields, substanceSite } from '../common/claim-substance';
import { subsetOf } from '../common/enum-values';

const TASK_TYPE = 'interview-pool-relevance';

/** Пункт [lag-told-only-the-log] 2026-09-24: имя места в одном месте —
 * иначе тот, кто ставит отметку, и тот, кто её читает, разъедутся
 * строкой (урок [label-is-the-choice]). */
const SNAPSHOT_LAG_SITE = 'poolRelevanceSnapshot.notAssessed';

interface RawCriterionResult {
  questionnaireItemId: string;
  coverage: 'covered' | 'partial' | 'not_covered';
  note: string;
  sourceSegmentId?: string | null;
}

interface RawCandidateAssessment {
  criteriaBreakdown: RawCriterionResult[];
  attentionPoints: string[];
  followUpRequests: string[];
}

// Экспортируется ради проверки на ПОВЕДЕНИИ: спека вызывает сам
// валидатор, а не ищет в его тексте слово `allFilled`
// (Пункт [finding-without-substance-2] 2026-09-26).
export function isValidAssessment(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.criteriaBreakdown)) return false;
    // Пункт [the-second-line-skipped-the-hiring-side] 2026-10-01: ВТОРАЯ
    // ЛИНИЯ запрета выводов о личности. В промпте выше запрет есть
    // («НЕ вердикт "цей кандидат поганий"») — это первая линия, и до
    // этого Пункта она была единственной у самого прямого разбора
    // уровня человека в продукте: `attentionPoints` рисуются рекрутеру
    // рядом с именем кандидата, в момент решения о нём. Проверяется
    // ВЕСЬ текст ответа, а не отдельные поля: вывод о личности может
    // оказаться и в `note` у критерия. Попадание — провал валидации,
    // то есть повтор запроса, а не запись утверждения о человеке.
    if (hasPersonVerdict(text)) return false;
    // Пункт [finding-without-substance-2] 2026-09-26: элементы этих двух
    // массивов не проверялись НИЧЕМ, кроме того что массив — массив.
    // Между тем followUpRequests становятся записями
    // `candidateFollowUpRequest` прямо из строк, а attentionPoints
    // рисуются кандидату как сигналы: пустая строка даёт пустой запрос
    // документа и пустой сигнал. Пустой массив законен и здесь и там —
    // это и есть способ сказать «нечего».
    if (!allStringsFilled(parsed?.attentionPoints)) return false;
    if (!allStringsFilled(parsed?.followUpRequests)) return false;
    return parsed.criteriaBreakdown.every(
      (c: any) =>
        typeof c?.questionnaireItemId === 'string' &&
        (ASSESSED_COVERAGE as readonly string[]).includes(c?.coverage) &&
        // Пункт [finding-without-substance-2] 2026-09-26: «частично» без
        // обоснования — вывод о кандидате, который нечем проверить.
        allFilled(c, itemFields(substanceSite('isValidAssessment').required)),
    );
  } catch {
    return false;
  }
}

// §2.4 ТЗ, наскрізна вимога — жорстка заборона в system prompt, не
// тільки сподівання, що модель сама здогадається. §2.6 ТЗ —
// genderRequirement/ageRequirement/isPhysicallyDemanding НІКОЛИ не
// потрапляють у контекст цього виклику (перевіряється тестом на
// побудові запиту, не тільки постфактум на виводі).
const SYSTEM_PROMPT =
  'Тебе дано транскрипт(и) співбесіди(конкретного кандидата з переліком питань анкети вакансії. ' +
  'Для КОЖНОГО питання анкети визнач coverage: "covered" (відповідь явно й повністю розкрила питання), ' +
  '"partial" (торкнулись, але не повністю), "not_covered" (питання взагалі не піднімалось) — з note (коротке обґрунтування) ' +
  'і sourceSegmentId (id репліки-джерела, якщо covered/partial). ' +
  'Також сформуй attentionPoints — сигнали, на які варто звернути увагу людині (НЕ вердикт "цей кандидат поганий", формулюй як "потребує перевірки", не як висновок), ' +
  'і followUpRequests — конкретні прогалини, які закриваються документом/прикладом роботи (не загальні побажання). ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не використовуй расу, стать, вік, релігію, інвалідність, вагітність, національність, сексуальну орієнтацію чи будь-які непрямі проксі-ознаки цих категорій (наприклад назва навчального закладу як маркер соціального класу, географія походження тощо) як підставу для жодного висновку — якщо в транскрипті це прозвучало, ІГНОРУЙ це повністю при оцінці. ' +
  'Відповідай СТРОГО валідним JSON вида {"criteriaBreakdown": [{"questionnaireItemId": string, "coverage": string, "note": string, "sourceSegmentId": string|null}], "attentionPoints": string[], "followUpRequests": string[]}. Без пояснень поза ним.';

/** Покрытие, которое может назвать разбор собеседования. Пункт
 * [enum-copy-drifted] 2026-09-29: `unknown` сюда НЕ входит намеренно —
 * это значение означает «вопрос не разбирали», и приходит оно не от
 * модели, а от отсутствия позиции вовсе. */
const ASSESSED_COVERAGE = subsetOf(
  ClauseCoverage,
  [ClauseCoverage.covered, ClauseCoverage.partial, ClauseCoverage.not_covered],
  'модель отвечает о том, что в разговоре прозвучало; «не разбирали» — не её ответ, а отсутствие ответа',
);

@Injectable()
export class InterviewPoolRelevanceService {
  private readonly logger = new Logger(InterviewPoolRelevanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    // Пункт [job-domain-v2] §6.2 / приёмка 8: после сверки покрытие анкеты
    // зеркалится в INTERVIEW-лист кандидата ЧЕРНОВИКАМИ позиций (человек
    // подтверждает). Optional — спеки v1 конструируют сервис двумя
    // аргументами и остаются контрактом без правок ожиданий.
    @Optional() private readonly sheets?: TermsSheetService,
  ) {}

  /** §4.3 ТЗ — знімок формується після КОЖНОЇ завершеної співбесіди,
   * бере ВСІ завершені співбесіди пулу (не тільки щойно завершену),
   * для КОЖНОГО кандидата пулу — один AI-виклик. Новий
   * PoolRelevanceSnapshot, не перезапис попереднього — історія
   * лишається доступною. */
  async regenerate(userId: string, projectId: string, triggerConversationId?: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }
    if (config.questions.length === 0) {
      throw new BadRequestException('У этого пула ещё нет зафиксированной анкеты — не с чем сравнивать');
    }

    const knownQuestionIds = new Set(config.questions.map((q: { id: string }) => q.id));

    const statuses = await this.prisma.candidatePipelineStatus.findMany({
      where: { projectId },
      include: {
        candidateProfile: true,
        // АУДИТ: раніше без completedAt — незавершена співбесіда
        // (conversationId вже прив'язаний через recordStageProgress,
        // але completedAt ще не проставлено) потрапляла б у оцінку
        // передчасно, з частковим транскриптом. §4.3 ТЗ буквально:
        // "після КОЖНОЇ ЗАВЕРШЕНОЇ співбесіди".
        stageProgress: { where: { conversationId: { not: null }, completedAt: { not: null } } },
      },
    });

    const snapshot = await this.prisma.poolRelevanceSnapshot.create({
      data: { projectId, triggerConversationId },
    });

    // Сверка «пустота, неотличимая от полноты» 2026-09-04: раньше каждая
    // из трёх причин ниже была молчаливым `continue` — кандидата просто не
    // было в снимке. Рекрутер видел четырёх из пяти и не мог отличить
    // «сравнили, совпадений нет» от «не сравнивали вовсе». По этому снимку
    // решают, с кем продолжать разговор, поэтому пропуск обязан быть
    // назван — с причиной и человеческим текстом.
    const notAssessed: Array<{ candidateProfileId: string; displayName: string | null; reason: string }> = [];
    const skip = (status: { candidateProfileId: string; candidateProfile?: { displayName?: string | null } | null }, reason: string) =>
      notAssessed.push({
        candidateProfileId: status.candidateProfileId,
        displayName: status.candidateProfile?.displayName ?? null,
        reason,
      });

    for (const status of statuses) {
      // А-6 (аудит 2026-09-03): отозвавший согласие не пересобирается в снимок.
      // Старые записи снимка задним числом не переписываются — они уже отданы;
      // новое по этому человеку просто не считается.
      if (consentRevoked(status)) {
        skip(status, 'Кандидат отозвал согласие на обработку — новые сверки по нему не выполняются.');
        continue;
      }
      const conversationIds = status.stageProgress.map((p: { conversationId: string | null }) => p.conversationId!).filter(Boolean);
      if (conversationIds.length === 0) {
        skip(status, 'Нет ни одного завершённого и расшифрованного собеседования — сверять пока не с чем.');
        continue;
      }

      const assessment = await this.assessCandidate(userId, projectId, config, conversationIds);
      if (!assessment) {
        // Честная деградация: сбой AI на одном кандидате не роняет весь
        // снимок — но и не делает вид, что кандидата сравнили.
        skip(status, 'Сверку не удалось выполнить: сбой AI-разбора. Это не результат сравнения — запустите пересчёт позже.');
        continue;
      }

      // [job-domain-v2]: лист INTERVIEW у кандидата заводится технически,
      // без кнопки; покрытие → черновики позиций с опорой на реплику.
      await this.mirrorIntoTermsSheet(userId, status.id, assessment.criteriaBreakdown.filter((b) => knownQuestionIds.has(b.questionnaireItemId)));

      await this.prisma.poolRelevanceEntry.create({
        data: {
          snapshotId: snapshot.id,
          candidateProfileId: status.candidateProfileId,
          // Фильтр по существующим вопросам (аудит 2026-09-02): в
          // job-search такой есть и прокомментирован, здесь забыли.
          // Выдуманный моделью questionnaireItemId попадал в БД и в
          // интерфейс, где вместо текста вопроса рисовался сырой id.
          criteriaBreakdown: assessment.criteriaBreakdown.filter((b: { questionnaireItemId: string }) =>
            knownQuestionIds.has(b.questionnaireItemId),
          ) as any,
          attentionPoints: assessment.attentionPoints,
          followUpRequestsDraft: assessment.followUpRequests,
        },
      });

      // §4.4 ТЗ — єдиний автоматичний перехід стадії, що система
      // робить сама: організаційний трекінг "чекаємо на матеріали",
      // не рішення про найм.
      if (assessment.followUpRequests.length > 0) {
        // АУДИТ 2026-09-02: пересчёт вызывается после КАЖДОЙ завершённой
        // собеседования и прогоняет всех кандидатов — без дедупликации
        // второй прогон создавал вторые копии тех же запросов, третий —
        // третьи. Отмеченные выполненными «воскресали» рядом с дублями,
        // и кандидат вечно висел в «ждём материалы».
        const openRequests = await this.prisma.candidateFollowUpRequest.findMany({
          where: { statusId: status.id },
          select: { requestText: true, fulfilled: true },
        });
        const knownTexts = new Set(openRequests.map((r: { requestText: string }) => r.requestText));
        const newRequests = assessment.followUpRequests.filter((text) => !knownTexts.has(text));
        if (newRequests.length > 0) {
          await this.prisma.candidateFollowUpRequest.createMany({
            data: newRequests.map((text) => ({ statusId: status.id, requestText: text })),
          });
        }
        // Стадию двигаем, только если реально чего-то ждём: все запросы
        // закрыты — не возвращать кандидата назад по воронке.
        const stillWaiting =
          newRequests.length > 0 ||
          openRequests.some((r: { fulfilled: boolean }) => !r.fulfilled);
        if (stillWaiting) {
          await this.prisma.candidatePipelineStatus.update({
            where: { id: status.id },
            data: { stage: CandidateStage.AWAITING_FOLLOWUP },
          });
        }
      }
    }

    // Список непроверенных пишется ОДНОЙ записью в конце: он про снимок
    // целиком, а не про отдельного кандидата. Отставание миграции терпится
    // — снимок важнее подписи, но молчать об отставании нельзя.
    if (notAssessed.length > 0) {
      try {
        await this.prisma.poolRelevanceSnapshot.update({
          where: { id: snapshot.id },
          data: { notAssessed: notAssessed as any },
        });
      } catch (err) {
        if (!isMissingColumnError(err)) throw err;
        warnMigrationLagOnce(
          this.logger,
          SNAPSHOT_LAG_SITE,
          'pool_snapshot_not_assessed_2026_09_04.sql',
          'снимок без списка непроверенных кандидатов — пропуски снова невидимы',
        );
      }
    }

    return this.getSnapshot(userId, snapshot.id);
  }

  /** Пункт [lag-told-only-the-log] 2026-09-24 — отставание миграции
   * доходит до ЧИТАТЕЛЯ снимка, а не только до лога сервера.
   *
   * Предупреждение выше названо своими словами: «пропуски снова
   * невидимы». Экран рисует блок «Не вошли в этот снимок» только при
   * непустом списке — значит при неприменённой миграции он не рисует
   * ничего, и снимок выглядит ПОЛНЫМ. Это зеркало того самого правила,
   * ради которого механизм терпимости и писался: пробел конфигурации не
   * должен выглядеть ни как отказ функции, ни как её полнота. */
  private withLagNote<T>(snapshot: T): T & { pendingMigration: { migration: string; consequence: string } | null } {
    return { ...(snapshot as object), pendingMigration: migrationLagAt(SNAPSHOT_LAG_SITE) } as T & {
      pendingMigration: { migration: string; consequence: string } | null;
    };
  }

  async getLatest(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const snapshot = await this.prisma.poolRelevanceSnapshot.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { entries: { include: { candidateProfile: true } } },
    });
    if (!snapshot) {
      throw new NotFoundException(`No PoolRelevanceSnapshot for project ${projectId} yet`);
    }
    // Оба выхода несут пометку: последний снимок читают чаще, чем
    // только что созданный, и именно его человек принимает за полный.
    return this.withLagNote(snapshot);
  }

  async getHistory(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    return this.prisma.poolRelevanceSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { entries: true },
    });
  }

  private async getSnapshot(userId: string, snapshotId: string) {
    const snapshot = await this.prisma.poolRelevanceSnapshot.findUnique({
      where: { id: snapshotId },
      include: { entries: { include: { candidateProfile: true } } },
    });
    return snapshot ? this.withLagNote(snapshot) : snapshot;
  }

  /** Зеркало criteriaBreakdown → ClausePosition (черновики) в INTERVIEW-листе.
   * Best-effort: сбой зеркала не должен ронять снимок v1. */
  private async mirrorIntoTermsSheet(userId: string, pipelineStatusId: string, breakdown: RawCriterionResult[]) {
    if (!this.sheets || breakdown.length === 0) return;
    try {
      const sheet = await this.sheets.openForCandidate(userId, pipelineStatusId, { silent: true });
      const byQuestion = new Map(
        sheet.clauses
          .filter((c) => c.side === TermsSide.EMPLOYER && c.kind === TermsClauseKind.REQUIREMENT && c.confirmedAt && !c.rejectedAt)
          .map((c) => [c.id, c] as const),
      );
      const raw = await this.prisma.termsClause.findMany({
        where: { sheetId: sheet.id, sourceQuestionnaireItemId: { not: null } },
        select: { id: true, sourceQuestionnaireItemId: true },
      });
      const clauseByQuestionId = new Map(raw.map((r) => [r.sourceQuestionnaireItemId as string, r.id]));
      for (const b of breakdown) {
        const clauseId = clauseByQuestionId.get(b.questionnaireItemId);
        if (!clauseId || !byQuestion.has(clauseId)) continue;
        // без реплики-источника позиция не сохраняется (§4.3)
        if (!b.sourceSegmentId) continue;
        await this.prisma.clausePosition.create({
          data: {
            clauseId,
            bySide: TermsSide.CANDIDATE,
            coverage: b.coverage as ClauseCoverage,
            note: b.note.slice(0, 600),
            evidenceKind: EvidenceKind.TRANSCRIPT_SEGMENT,
            evidenceRef: b.sourceSegmentId,
            confirmedAt: null,
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Зеркало релевантности в лист условий не записано: ${(err as Error).message}`);
    }
  }

  /** §2.4/§2.6 ТЗ — побудова контексту для AI НІКОЛИ не включає
   * genderRequirement/ageRequirement/isPhysicallyDemanding конфігу —
   * структурна гарантія, не постфактум-фільтр виводу. */
  private async assessCandidate(
    userId: string,
    projectId: string,
    config: { id: string; jobTitle: string; questions: Array<{ id: string; text: string; category: string | null; isRequired: boolean }> },
    conversationIds: string[],
  ): Promise<RawCandidateAssessment | null> {
    const segments = await this.prisma.transcriptSegment.findMany({
      where: { transcript: { conversationId: { in: conversationIds } } },
      orderBy: { startMs: 'asc' },
    });
    if (segments.length === 0) return null;

    const transcript = numberedTranscript(segments);
    const transcriptText = transcript.text;
    const questionsText = config.questions
      .map((q) => `[id=${q.id}] ${q.text}${q.isRequired ? ' (обов\'язково)' : ''}`)
      .join('\n');
    const userPrompt = `Вакансія: ${config.jobTitle}\n\nПитання анкети:\n${questionsText}\n\nТранскрипт співбесіди:\n${transcriptText}`;

    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 3000,
        validateOutput: isValidAssessment,
      });
      // Сверка «ссылка на реплику» 2026-09-04: правило §4.3 («позиция
      // кандидата не сохраняется без реплики-источника») проверяло, что
      // поле НЕ ПУСТОЕ. Выдуманный моделью id проходил его насквозь и
      // ложился в лист условий как доказательство. Теперь номер
      // переводится в настоящий id, а несуществующий обнуляется — и
      // правило ниже отсекает такую позицию, как и задумано.
      const parsed = JSON.parse(result.text) as RawCandidateAssessment;
      return {
        ...parsed,
        criteriaBreakdown: parsed.criteriaBreakdown.map((b) => ({
          ...b,
          sourceSegmentId: resolveSegmentRef(transcript.byRef, b.sourceSegmentId),
        })),
      };
    } catch (err) {
      // [ai-errors] 2026-09-02: здесь ОСОЗНАННО НЕ общий шлюз
      // rethrowClientVisibleAiError. Это точка ЧЕСТНОЙ ДЕГРАДАЦИИ:
      // отсутствие модели (не засеяна база, нет ключа) обязано
      // деградировать, как и любой другой сбой AI, а не ронять фичу
      // целиком — иначе шлюз, задуманный как «конфигурация не должна
      // выглядеть отказом», сам превратил бы конфигурацию в отказ.
      // Наружу уходит только отсутствие прав.
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) return null;
      // Чесна деградація — збій одного AI-виклику не повинен провалити
      // весь знімок пулу (інші кандидати могли обробитись успішно).
      return null;
    }
  }
}
