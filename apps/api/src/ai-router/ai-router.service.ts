// MVP-фича 1: AIRouterService — единственная точка, через которую
// остальной код продукта обращается к внешним AI-провайдерам.
//
// Раньше (чекпоинт 1, пункты 5-7) была только модель данных (AIJob,
// AIModelVersion, AIModelCapability). Здесь эта модель данных наконец
// оживает: реальный HTTP-вызов, реальный retry с fallback на другую
// модель при сбое, реальная запись AIInference по итогу.
//
// Обновление: TODO про ConsentService и ContentScanService закрыты —
// оба сервиса написаны и подключены ниже. Единственное, что всё ещё
// не сделано на этом проходе: реальный интеграционный прогон против
// настоящих API-ключей (сеть отключена в среде разработки).

import { Injectable, Logger, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { ContentScanService } from '../content-scan/content-scan.service';
import { providerHasUsableKey } from '../common/provider-key';
import {
  AIProviderCompletionParams,
  ContentBlock,
  requiresMedia,
  selectProviderClient,
  providerSupportsLane,
  isProviderClientRegistered,
  AILane,
  EXTERNAL_INTERACTION_MAX_WAIT_MS,
  ProviderHttpError,
} from './ai-provider-client';
import {
  FUNCTION_MAX_DURATION_MS,
  SYNC_LEASE_MS,
  fitsAnotherProviderCall,
  msLeftForOutcome,
} from './sync-budget';
import { MediaUriResolverService } from './media-uri-resolver.service';
import { MAX_USER_PROMPT_CHARS, assertWithinLimit } from './prompt-limits';
import {
  DEFAULT_AI_RESPONSE_LANGUAGE,
  normalizeLanguageCode,
  withResponseLanguage,
} from '../common/ai-response-language';
import { isBackgroundCapable, GeminiApiError } from './gemini-client';
import {
  Prisma,
  AIJobStatus,
  InputScanStatus,
  SchemaValidationResult,
  ConsentType,
  ScanTargetType,
} from '@prisma/client';
import { spendLimit } from '../common/spend-limits';
import { FROZEN_JOB_REASON } from '../project-freeze/frozen-background';
import { failureText, type FailureKind, type FailureText } from './failure-reason';
import { checkJsonMode } from './json-mode';

export interface AIRouterRequest {
  /** Кто инициирует вызов — обязателен для проверки ConsentRecord.
   * Раньше этого поля не было (TODO не мог быть закрыт без него). */
  userId: string;
  projectId?: string;
  taskType: string;
  promptVersionId?: string;
  systemPrompt?: string;
  /** Пункт [multimodal] §3.2 — строка ИЛИ блоки. Все существующие
   * вызовы передают строку и не меняются. Медиа-блоки допустимы
   * ТОЛЬКО через enqueue() — execute() их отвергает (§4.1: вызов не
   * помещается в maxDuration функции). */
  userPrompt: string | ContentBlock[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  validateOutput?: (text: string) => boolean;
  preferredModelVersionId?: string;
  maxRetries?: number;
  /** Пункт [ai-locale] 2026-09-02: язык ответа. По умолчанию берётся
   *  язык пользователя (User.languageCode из Telegram); поле нужно
   *  редким вызовам, где язык диктует не пользователь. */
  responseLanguage?: string;
}

export interface AIRouterResult {
  aiInferenceId: string;
  jobId: string;
  text: string;
}

export class AIRouterExhaustedError extends Error {
  constructor(taskType: string, attempts: number) {
    super(
      `AI Router exhausted all attempts (${attempts}) for taskType="${taskType}" — no model succeeded, including fallback`,
    );
    this.name = 'AIRouterExhaustedError';
  }
}

export class AIRouterNoCapableModelError extends Error {
  constructor(taskType: string, detail?: string) {
    // Пункт [router-simplify] 2026-09-01: причин ровно две, и обе — про
    // конфигурацию, а не про провайдера. Аудит 2026-09-02: точная
    // причина (нет строк / нет ключа — и у кого / устаревший
    // preferredModelVersionId) раньше уходила ТОЛЬКО в лог, а
    // вызывающий код и оператор видели общий текст «либо… либо…» и
    // искали не там. Теперь она в самом сообщении; общий текст остаётся
    // запасным, когда детали нет. Имена переменных окружения — не
    // секреты, их значения сюда не попадают.
    super(
      `Нет модели, которой можно отдать задачу "${taskType}": ` +
        (detail ??
          'либо в базе нет активных AIModelCapability (выполните prisma:seed), ' +
            'либо ни у одной активной модели не задан ключ провайдера'),
    );
    this.name = 'AIRouterNoCapableModelError';
  }
}

export class AIRouterContentBlockedError extends Error {
  constructor(reason: string) {
    super(`AI Router blocked the request: ${reason}`);
    this.name = 'AIRouterContentBlockedError';
  }
}

// ── Пункт [multimodal] §4 — асинхронная полоса ──

/** Лизинг QUEUED-джобы: если воркер не поставил задачу провайдеру за
 * это время, сторожевая переводит её в FAILED — иначе джоба висит
 * навсегда (класс бага «застрявший PROCESSING», уже найденный аудитом
 * в media-review). */
export const QUEUED_LEASE_MS = 15 * 60 * 1000;

/** Сериализуемая часть AIRouterRequest для AIJob.pendingRequest.
 * validateOutput сюда не попадает (функция не сериализуется) —
 * валидация асинхронных джоб живёт в реестре по taskType, см.
 * registerOutputValidator(). */
export interface PendingRequestPayload {
  userId: string;
  projectId?: string;
  taskType: string;
  promptVersionId?: string;
  systemPrompt?: string;
  userPrompt: string | ContentBlock[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  maxRetries: number;
}

export type AsyncJobOutcome =
  | { kind: 'completed'; jobId: string; aiInferenceId: string }
  // Пункт [failure-spoke-to-the-operator] 2026-09-25: вид провала едет
  // рядом с текстом. Обработчику завершения раньше приходилось узнавать
  // вид ПО ПОДСТРОКЕ в человеческом тексте — то есть текст сообщения был
  // негласным контрактом, и его правка молча ломала поведение (тот же
  // разбор, что в [error-language]).
  | { kind: 'failed'; jobId: string; reason: string; failureKind?: FailureKind }
  | { kind: 'waiting'; jobId: string };

type ModelVersionWithProvider = {
  id: string;
  version: string;
  model: {
    name: string;
    provider: { name: string; apiEndpoint: string | null; credentialRef: string | null };
  };
};

/** Длина запроса к модели — по строке или по текстовым блокам мультимодального
 * запроса (медиа считается ссылкой, её объём ограничен своими проверками). */
function assertPromptWithinLimit(userPrompt: string | ContentBlock[]): void {
  const text =
    typeof userPrompt === 'string'
      ? userPrompt
      : userPrompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
  assertWithinLimit(text, MAX_USER_PROMPT_CHARS, 'Запрос к модели');
}

/** Пункт [background-jobs] 2026-09-04 — потолок порции сторожевой.
 * Того же порядка, что SUBMIT_BATCH/POLL_BATCH в ai-jobs.controller.ts:
 * закрытие джобы дешёвое, но тянет за собой сообщение в Telegram. */
const REAP_BATCH = 50;

@Injectable()
export class AIRouterService {
  private readonly logger = new Logger(AIRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
    private readonly contentScan: ContentScanService,
    private readonly mediaResolver: MediaUriResolverService,
  ) {}

  // ── Пункт [multimodal] — реестры асинхронной полосы ──
  //
  // validateOutput — функция и в pendingRequest не сериализуется,
  // поэтому для асинхронных джоб валидатор регистрируется по taskType
  // (модуль-владелец делает это в onModuleInit). Обработчик завершения
  // — тем же способом: роутер не знает про media-review, media-review
  // знает про роутер, цикла модулей нет.
  private readonly outputValidators = new Map<string, (text: string) => boolean>();
  private readonly completionHandlers = new Map<
    string,
    (outcome: AsyncJobOutcome) => Promise<void>
  >();

  registerOutputValidator(taskType: string, validator: (text: string) => boolean): void {
    this.outputValidators.set(taskType, validator);
  }

  registerCompletionHandler(taskType: string, handler: (outcome: AsyncJobOutcome) => Promise<void>): void {
    this.completionHandlers.set(taskType, handler);
  }

  private async notifyCompletion(taskType: string | null, outcome: AsyncJobOutcome): Promise<void> {
    if (!taskType) return;
    const handler = this.completionHandlers.get(taskType);
    if (!handler) return;
    try {
      await handler(outcome);
    } catch (err) {
      // Обработчик — потребитель результата, его сбой не должен
      // ронять воркер целиком: остальные джобы батча важнее.
      this.logger.error(`Completion handler for "${taskType}" failed on job ${outcome.jobId}: ${err}`);
    }
  }

  async execute(request: AIRouterRequest): Promise<AIRouterResult> {
    // Пункт [multimodal] §4.1: медиа-вызов не помещается в maxDuration
    // serverless-функции (замерено 25–32 с на 30-секундном ролике) —
    // тот же класс отказа, что лимит 4,5 МБ: платформа отказывает выше
    // нашего кода. Для медиа существует enqueue().
    if (requiresMedia(request.userPrompt)) {
      throw new AIRouterContentBlockedError(
        'media content blocks must go through enqueue() — synchronous execute() cannot outlive the serverless function',
      );
    }

    const prepared = await this.prepareJob(request, 'sync', true);
    if (prepared.reused) {
      return prepared.reused;
    }

    // Пункт [the-retry-killed-the-record] 2026-09-30: начало отсчёта
    // бюджета функции. Берётся ПОСЛЕ пролога намеренно — пролог
    // (согласие, скан, потолки) наружу не ходит и в предел функции
    // укладывается всегда, а занижение остатка отменило бы осмысленные
    // повторы.
    const startedAtMs = Date.now();

    try {
      return await this.attemptWithRetryAndFallback(
        prepared.job!.id,
        prepared.modelVersion,
        prepared.sanitizedRequest,
        prepared.maxRetries,
        startedAtMs,
      );
    } catch (err) {
      await this.prisma.aIJob.update({
        where: { id: prepared.job!.id },
        data: { status: AIJobStatus.FAILED, completedAt: new Date(), leaseExpiresAt: null },
      });
      throw err;
    }
  }

  /** Пункт [multimodal] §4.4 — асинхронная постановка. Тот же пролог,
   * что execute() (общий prepareJob — дублирования нет намеренно),
   * но вместо вызова провайдера джоба остаётся QUEUED с сериализованным
   * запросом; исполняет её воркер (submitQueued/pollRunning). */
  async enqueue(request: AIRouterRequest): Promise<{ jobId: string }> {
    const prepared = await this.prepareJob(request, 'background');

    const payload: PendingRequestPayload = {
      userId: prepared.sanitizedRequest.userId,
      projectId: prepared.sanitizedRequest.projectId,
      taskType: prepared.sanitizedRequest.taskType,
      promptVersionId: prepared.sanitizedRequest.promptVersionId,
      systemPrompt: prepared.sanitizedRequest.systemPrompt,
      userPrompt: prepared.sanitizedRequest.userPrompt,
      maxTokens: prepared.sanitizedRequest.maxTokens,
      temperature: prepared.sanitizedRequest.temperature,
      jsonMode: prepared.sanitizedRequest.jsonMode,
      maxRetries: prepared.maxRetries,
    };

    await this.prisma.aIJob.update({
      where: { id: prepared.job!.id },
      data: {
        pendingRequest: payload as never,
        leaseExpiresAt: new Date(Date.now() + QUEUED_LEASE_MS),
      },
    });

    return { jobId: prepared.job!.id };
  }

  /** Заблокированная сканом попытка — как FAILED-джоба с
   * inputScanStatus = BLOCKED, чтобы телеметрия и операторская сводка
   * видели инъекции по факту, а не по нулю. Модель подбирается тем же
   * resolveModelVersion — если её нет (ключи не настроены), запись
   * пропускается: телеметрия не важнее честного ответа клиенту. */
  private async recordBlockedAttempt(request: AIRouterRequest, lane: AILane, scanResultIds: string[]): Promise<void> {
    try {
      const modelVersion = await this.resolveModelVersion(
        request.taskType,
        request.preferredModelVersionId,
        lane,
        requiresMedia(request.userPrompt),
      );
      const job = await this.prisma.aIJob.create({
        data: {
          inputHash: this.hashInput(request),
          modelVersionId: modelVersion.id,
          promptVersionId: request.promptVersionId,
          taskType: request.taskType,
          status: AIJobStatus.FAILED,
          inputScanStatus: InputScanStatus.BLOCKED,
          retryPolicy: 'blocked by input scan — no attempts',
          requestUserId: request.userId,
          completedAt: new Date(),
          partialResult: 'запрос отклонён сканом входа (prompt injection) до обращения к провайдеру',
        },
      });
      if (scanResultIds.length > 0) {
        await this.prisma.contentScanResult.updateMany({
          where: { id: { in: scanResultIds } },
          data: { aiJobId: job.id },
        });
      }
    } catch (err) {
      this.logger.warn(`Заблокированная сканом попытка не записана в телеметрию: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Общий пролог execute()/enqueue() — ТЗ §4.4 требует именно общий
   * метод, а не копию: копия проверки в каждой точке — способ
   * разъехаться, уже дважды стоивший дыр (см. ConsentService). */
  private async prepareJob(request: AIRouterRequest, lane: AILane, allowReuse = false) {
    // Аудит границ ввода 2026-09-03: единственный общий потолок длины
    // запроса. Часть сервисов резала вход сама, часть отдавала текст
    // клиента как есть — то есть правило существовало, но не было общим,
    // и живые циклы (клиент вызывает их каждые 15–45 секунд и сам задаёт
    // содержимое окна) могли слать сколько угодно. Проверка здесь, до
    // согласия и до скана: платит за длину владелец, а не тот, кто её
    // прислал. Подробности и почему нельзя молча обрезать — в
    // prompt-limits.ts.
    assertPromptWithinLimit(request.userPrompt);

    // Согласие на внешний AI — для любых вызовов.
    await this.consent.requireConsent(request.userId, ConsentType.EXTERNAL_AI, request.projectId);

    // Пункт [multimodal] §10.4 — как только через роутер идёт АУДИО
    // пользователя (blob-медиа), включается та же тройка проверок, что
    // у шести существующих точек выхода аудио наружу: MAXIMUM_PRIVACY
    // (жёсткий запрет) → RECORDING → EPHEMERAL_SERVER. Роутер — седьмая
    // и последняя точка. Публичное YouTube-видео проверки не требует:
    // своих данных пользователя там нет.
    if (Array.isArray(request.userPrompt)) {
      const hasBlobMedia = request.userPrompt.some(
        (b) => b.type === 'media' && b.ref.source === 'blob',
      );
      if (hasBlobMedia) {
        await this.consent.assertAudioMayLeaveDevice(request.userId, request.projectId);
      }
    }

    const { sanitizedPrompt, scanResultIds, blocked } = await this.scanPrompt(request.userPrompt);
    if (blocked) {
      // Аудит 2026-09-02 (AI router): раньше блокировка бросала ошибку ДО
      // создания джобы, и AIJob.inputScanStatus = BLOCKED не появлялся в
      // базе никогда — телеметрия inputBlockedCount была структурно
      // нулём, а операторская сводка молча показывала «инъекций нет».
      // Теперь заблокированная попытка записывается FAILED-джобой со
      // статусом скана BLOCKED (у пользователя, у фичи, с привязкой
      // результатов скана). Запись — best-effort: её отказ не должен
      // превращать честный 4xx «запрос отклонён» в 500.
      await this.recordBlockedAttempt(request, lane, scanResultIds);
      throw new AIRouterContentBlockedError(
        'prompt injection pattern detected in userPrompt — request rejected before reaching any AI provider',
      );
    }
    // Пункт [ai-locale] 2026-09-02: язык ответа задаётся ЗДЕСЬ, в общей
    // воронке execute()/enqueue(), а не в промпте каждой фичи. До этого
    // язык не задавался нигде, и модель отвечала на языке входных
    // данных: разбор украинского видео приходил по-английски
    // русскоязычному пользователю. Инструкция уходит и в
    // pendingRequest асинхронных джоб — медиа-разбор получает её тоже.
    const language = await this.resolveResponseLanguage(request);
    const sanitizedRequest: AIRouterRequest = {
      ...request,
      userPrompt: sanitizedPrompt,
      systemPrompt: withResponseLanguage(request.systemPrompt, language),
    };

    const modelVersion = await this.resolveModelVersion(
      sanitizedRequest.taskType,
      sanitizedRequest.preferredModelVersionId,
      lane,
      requiresMedia(sanitizedRequest.userPrompt),
    );

    const inputHash = this.hashInput(sanitizedRequest);
    const maxRetries = sanitizedRequest.maxRetries ?? 2;

    // Пункт [idempotency] 2026-09-01 (продуктовое решение владельца:
    // «реализовать идемпотентность AI-вызовов» — поле inputHash
    // писалось с implementation-ready §7 и не читалось никогда).
    // Идемпотентность здесь — защита от ПОВТОРНОЙ ОТПРАВКИ того же
    // запроса (двойной клик, сетевой ретрай клиента, двойной cron), а
    // не вечный кэш ответов: окно короткое (env
    // AI_IDEMPOTENCY_WINDOW_MINUTES, дефолт 10; 0 = выключено), чтобы
    // осознанное «перегенерировать» позже давало свежий вывод
    // (temperature>0 — вариативность выхода задумана). Действует ТОЛЬКО
    // для синхронного execute(): у асинхронной полосы (enqueue) маппинг
    // jobId→сущность строго 1:1 (media-review, паралингвистика) —
    // переиспользование джобы ломало бы обработчики завершения.
    // Проверка ДО суточного лимита: переиспользование бесплатно и
    // лимит не тратит. Совпадение требует ТОГО ЖЕ пользователя
    // (requestUserId) — кросс-пользовательского переиспользования нет.
    // Аудит 2026-09-02 (AI router): переиспользование — только при ТОЙ ЖЕ
    // разрешённой модели. preferredModelVersionId в хэш не входит, и
    // «сравнить движки» на одном промпте (админский селектор) молча
    // возвращало ответ предыдущей модели за новую.
    if (allowReuse) {
      const reused = await this.findReusableResult(sanitizedRequest, inputHash, modelVersion.id);
      if (reused) {
        return { reused, job: null, modelVersion: null, sanitizedRequest, maxRetries } as const;
      }
    }

    // Пункт [rate-limits] 2026-09-01 (из отчёта аудита «глобального
    // rate-limiting нет») — суточный потолок AI-вызовов НА ПОЛЬЗОВАТЕЛЯ
    // одним местом для всех фич: prepareJob проходят и execute(), и
    // enqueue(). Счёт по БД (aIJob.requestUserId + createdAt) — тот же
    // паттерн, что дневной лимит Vision OCR; in-memory в serverless
    // бессмысленен (каждый инстанс свой). Потолок из env, дефолт 300 —
    // заведомо выше честного дневного использования одного человека,
    // но останавливает скрипт, жгущий бюджет. 0 = выключено.
    await this.assertUnderDailyAiLimit(sanitizedRequest.userId);
    // Аудит 2026-09-02 (AI router): отдельный, более низкий потолок для
    // МЕДИА-задач (видео/аудио через Gemini) — один такой вызов стоит на
    // порядки дороже текстового, и общий лимит в 300 его не сдерживал.
    if (requiresMedia(sanitizedRequest.userPrompt)) {
      await this.assertUnderDailyMediaLimit(sanitizedRequest.userId, sanitizedRequest.taskType);
    }

    const job = await this.prisma.aIJob.create({
      data: {
        inputHash,
        modelVersionId: modelVersion.id,
        promptVersionId: sanitizedRequest.promptVersionId,
        // Пункт [telemetry]: без этого поля агрегация телеметрии
        // возможна только по AI-модели, не по фиче — см.
        // devils-advocate-telemetry-tz.md §3.
        taskType: sanitizedRequest.taskType,
        status: AIJobStatus.QUEUED,
        // Скан пройден по построению — заблокированный запрос до этой
        // строки не доходит (см. recordBlockedAttempt). PENDING по
        // умолчанию схемы оставлял поле вечно «не проверено».
        inputScanStatus: InputScanStatus.PASSED,
        retryPolicy: `${maxRetries} attempts, then fallback if configured`,
        // Владелец запроса — для GET /ai-jobs/:id («только свои
        // джобы»). Поле добавлено сверх списка ТЗ §4.3 ровно потому,
        // что без него требование §4.4 о проверке владения выполнить
        // нечем: pendingRequest обнуляется при завершении.
        requestUserId: sanitizedRequest.userId,
        // Пункт [the-retry-killed-the-record] 2026-09-30: срок аренды
        // для СИНХРОННОЙ полосы. Без него сторожевая не видела джобу,
        // убитую пределом функции (условие `lt: now` для NULL не
        // выполняется), и та оставалась RUNNING навсегда. Асинхронная
        // полоса свой, более короткий срок забора выставляет ниже, в
        // enqueue(), — поэтому здесь NULL, а не общее значение.
        leaseExpiresAt: lane === 'sync' ? new Date(Date.now() + SYNC_LEASE_MS) : null,
      },
    });

    // Привязываем результаты скана к конкретной job постфактум — на
    // момент scan() job ещё не существовала (скан идёт до подбора модели
    // намеренно: не тратим выбор модели на контент, который всё равно
    // будет заблокирован/очищен).
    if (scanResultIds.length > 0) {
      await this.prisma.contentScanResult.updateMany({
        where: { id: { in: scanResultIds } },
        data: { aiJobId: job.id },
      });
    }

    return { reused: null, job, modelVersion, sanitizedRequest, maxRetries };
  }

  /** Пункт [multimodal] §10.2 — скан промпта, который может быть
   * строкой или блоками. Текстовые блоки сканируются как раньше,
   * КАЖДЫЙ отдельно (иначе санитизацию не разложить обратно по
   * блокам). Медиа-блоки регэкспом сканировать нечего — они
   * записываются в ContentScanResult как непроверенные, с MediaRef в
   * externalRef. Prompt injection ВНУТРИ ролика (текст на экране,
   * произнесённая инструкция) этим НЕ закрывается — реальный вектор,
   * частично компенсируемый строгой валидацией выхода; принятая
   * граница, названная в ТЗ прямо. */
  private async scanPrompt(userPrompt: string | ContentBlock[]): Promise<{
    sanitizedPrompt: string | ContentBlock[];
    scanResultIds: string[];
    blocked: boolean;
  }> {
    if (typeof userPrompt === 'string') {
      const outcome = await this.contentScan.scan({
        text: userPrompt,
        targetType: ScanTargetType.AI_JOB_INPUT,
      });
      return {
        sanitizedPrompt: outcome.sanitizedText,
        scanResultIds: [outcome.resultId],
        blocked: outcome.blocked,
      };
    }

    const scanResultIds: string[] = [];
    const sanitized: ContentBlock[] = [];
    for (const block of userPrompt) {
      if (block.type === 'text') {
        const outcome = await this.contentScan.scan({
          text: block.text,
          targetType: ScanTargetType.AI_JOB_INPUT,
        });
        scanResultIds.push(outcome.resultId);
        if (outcome.blocked) {
          return { sanitizedPrompt: userPrompt, scanResultIds, blocked: true };
        }
        sanitized.push({ type: 'text', text: outcome.sanitizedText });
      } else {
        const refLabel =
          block.ref.source === 'youtube'
            ? `media:youtube:${block.ref.videoId}`
            : `media:blob:${block.ref.pathname}`;
        const outcome = await this.contentScan.scan({
          text: '',
          targetType: ScanTargetType.AI_JOB_INPUT,
          externalRef: refLabel,
        });
        scanResultIds.push(outcome.resultId);
        sanitized.push(block);
      }
    }
    return { sanitizedPrompt: sanitized, scanResultIds, blocked: false };
  }

  /**
   * Язык ответа: явное указание вызывающего > язык пользователя из
   * Telegram > дефолт. Отдельный запрос за языком дешевле, чем тащить
   * его через шесть десятков вызывающих сервисов, и не даёт им забыть.
   */
  private async resolveResponseLanguage(request: AIRouterRequest): Promise<string> {
    const explicit = normalizeLanguageCode(request.responseLanguage);
    if (explicit) return explicit;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: request.userId },
        select: { languageCode: true },
      });
      return normalizeLanguageCode(user?.languageCode) ?? DEFAULT_AI_RESPONSE_LANGUAGE;
    } catch (error) {
      // Найдено живым прогоном 2026-09-02: код с колонкой languageCode
      // выкатился раньше, чем к базе применили ai_locale_2026_09_02.sql,
      // и КАЖДЫЙ AI-вызов падал на «The column users.languageCode does
      // not exist» — пользователь видел «AI-фоллбек не удался», то есть
      // отставание миграции выглядело как сбой AI.
      //
      // Язык ответа — улучшение, а не условие работы: не знаем языка —
      // отвечаем на дефолтном. Ровно тот же принцип, что и в остальных
      // правках этой серии: пробел в конфигурации не должен выглядеть
      // как отказ фичи. Предупреждение в лог — чтобы отставание базы
      // всё-таки было видно тому, кто её и чинит.
      this.logger.warn(
        `Не удалось прочитать язык пользователя (${
          error instanceof Error ? error.message : String(error)
        }). Отвечаем на языке по умолчанию (${DEFAULT_AI_RESPONSE_LANGUAGE}). ` +
          'Если в сообщении упомянута колонка users.languageCode — примените ' +
          'prisma/manual-migrations/ai_locale_2026_09_02.sql по DIRECT_URL.',
      );
      return DEFAULT_AI_RESPONSE_LANGUAGE;
    }
  }

  /**
   * Подбор модели. Пункт [router-simplify] 2026-09-01 — переписан.
   *
   * Было: строка AIModelCapability на КАЖДУЮ пару (модель × taskType).
   * Отсутствие строки под новую задачу означало «AI-провайдер
   * недоступен» при полностью настроенных ключах — так и умерли разом
   * семь доменов (AUDIT-AI-CAPABILITIES-2026-09-01.md). При этом
   * измерение taskType не отвечало ни на один вопрос: текстовые модели
   * умеют все текстовые задачи одинаково.
   *
   * Стало: кандидаты — активные модели, которым ЕСТЬ ЧЕМ платить, то
   * есть чей ключ реально задан в окружении. taskType в подборе больше
   * не участвует (остаётся в телеметрии и в тексте ошибок). Из БД
   * читаются ровно два ответа, которых в ключах нет: можно ли модели
   * давать медиа и не выключена ли она вручную.
   *
   * Порядок кандидатов — по createdAt: «первая настроенная выигрывает»,
   * смена приоритета — деактивацией, явным действием. Автоматического
   * перебора провайдеров при ошибке по-прежнему нет (fallback — только
   * по заранее проставленному fallbackModelVersionId): «нет ключа» — не
   * ошибка вызова, а отсутствие кандидата, и решается ДО вызова.
   */
  private async resolveModelVersion(
    taskType: string,
    preferredId: string | undefined,
    lane: AILane,
    needsMedia = false,
  ): Promise<ModelVersionWithProvider> {
    const rows = await this.prisma.aIModelCapability.findMany({
      where: {
        availability: 'active',
        ...(needsMedia ? { OR: [{ vision: true }, { audio: true }] } : {}),
      },
      include: { modelVersion: { include: { model: { include: { provider: true } } } } },
      orderBy: { createdAt: 'asc' },
    });

    // Регрессия 2026-09-02: активная строка провайдера, которому нечем
    // отправить запрос (нет клиента в selectProviderClient), проходила в
    // кандидаты и роняла обе попытки. Так осталась висеть capability
    // транскрибации после [router-simplify]: раньше её отсекал фильтр по
    // taskType. Отсутствие клиента — признак «не кандидат», а не сбой.
    //
    // Пункт [router-lanes] 2026-09-02 — вторая половина того же
    // признака. Клиент есть не значит «этой задаче подходит»: Gemini
    // обслуживает только фоновую полосу, и на текстовом синхронном
    // вызове падал бы на «GeminiClient is background-only». А его
    // capability сид заводит РАНЬШЕ текстовых моделей, то есть при
    // заданном GEMINI_API_KEY он выигрывал подбор у всех.
    const candidates: typeof rows = [];
    const otherLane: string[] = [];
    const withoutClient: string[] = [];
    for (const row of rows) {
      const name = row.modelVersion.model.provider.name;
      if (providerSupportsLane(name, lane)) candidates.push(row);
      else if (isProviderClientRegistered(name)) otherLane.push(name);
      else withoutClient.push(name);
    }
    // Разные уровни намеренно (ревью 2026-09-02): «Gemini не берётся на
    // синхронную задачу» — норма при засеянной базе, и WARN об этом на
    // КАЖДОМ вызове приучал бы не читать логи. А вот активная строка
    // провайдера, которому нечем отправить запрос, — конфигурация БД,
    // которую надо чинить.
    if (otherLane.length > 0) {
      this.logger.debug(
        `Пропущены модели другой полосы (${lane}): ${[...new Set(otherLane)].join(', ')}`,
      );
    }
    if (withoutClient.length > 0) {
      this.logger.warn(
        `Пропущены активные модели провайдеров без клиента: ${[...new Set(withoutClient)].join(', ')}. ` +
          'Это конфигурация БД: деактивируйте их capability (availability != active) или уберите — ' +
          'запрос им отправить нечем.',
      );
    }

    if (preferredId) {
      // Явный выбор пользователя (§3.15 ТЗ) уважается, но выбирать он
      // может только из того же множества: устаревший id из селектора
      // движков не должен уводить запрос в провайдера без клиента.
      const preferred = candidates.find((c) => c.modelVersionId === preferredId);
      if (!preferred) {
        throw new AIRouterNoCapableModelError(
          taskType,
          `выбранная модель (${preferredId}) не входит в активные модели этой задачи на полосе ${lane}` +
            (needsMedia ? ' с поддержкой медиа' : '') +
            ' — обновите выбор в селекторе движков или capability в базе',
        );
      }
      const preferredProvider = preferred.modelVersion.model.provider;
      if (!(await this.hasUsableKey(preferredProvider))) {
        throw new AIRouterNoCapableModelError(
          taskType,
          `у выбранной модели ${preferred.modelVersion.version} не задан ключ провайдера ${preferredProvider.name} ` +
            `(${preferredProvider.credentialRef ?? 'credentialRef не задан'})`,
        );
      }
      return preferred.modelVersion;
    }

    const withoutKey: string[] = [];
    for (const candidate of candidates) {
      const provider = candidate.modelVersion.model.provider;
      if (await this.hasUsableKey(provider)) {
        return candidate.modelVersion;
      }
      withoutKey.push(`${provider.name} (${provider.credentialRef ?? 'credentialRef не задан'})`);
    }

    // Диагноз в лог — иначе «нет кандидата» неотличимо от «провайдер
    // отказал», а искать будут в ключах провайдера, который и так не
    // выбран. Названы обе причины: моделей нет вовсе или ни у одной нет ключа.
    const detail =
      candidates.length === 0
        ? `нет активных моделей${needsMedia ? ' с поддержкой медиа' : ''} на полосе ${lane} — ` +
          'в базе нет строк AIModelCapability для этой задачи (выполните `npm run prisma:seed`)'
        : `ни у одной активной модели нет ключа провайдера: ${withoutKey.join(', ')}`;
    this.logger.error(`Задача ${taskType}: ${detail}`);
    throw new AIRouterNoCapableModelError(taskType, detail);
  }

  /** Ключ провайдера реально доступен в окружении. Ровно этот вопрос
   *  раньше не задавался: роутер брал первую настроенную модель и падал
   *  на 401 у провайдера, чьего ключа в проекте нет вообще. */
  private hasUsableKey(provider: { apiEndpoint: string | null; credentialRef: string | null }): Promise<boolean> {
    return providerHasUsableKey(this.secrets, provider);
  }

  private async attemptWithRetryAndFallback(
    jobId: string,
    modelVersion: ModelVersionWithProvider,
    request: AIRouterRequest,
    maxRetries: number,
    /** Начало отсчёта бюджета функции. Пункт
     *  [the-retry-killed-the-record] 2026-09-30. */
    startedAtMs: number,
  ): Promise<AIRouterResult> {
    await this.prisma.aIJob.update({
      where: { id: jobId },
      data: { status: AIJobStatus.RUNNING },
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.callAndPersist(jobId, modelVersion, request, attempt);
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `Job ${jobId} attempt ${attempt}/${maxRetries} on ${modelVersion.model.name} failed: ${err}`,
        );
        await this.prisma.aIJob.update({
          where: { id: jobId },
          data: { retryCount: { increment: 1 } },
        });
        // Пункт [external-timeouts] 2026-09-01 — из отчёта аудита
        // («ретраи без бэкоффа, включая ретраи на 401/400»):
        // 4xx-ошибка провайдера не станет успехом со второй попытки —
        // выходим сразу (fallback-ветка ниже сохраняется: другой
        // провайдер может принять тот же запрос).
        if (err instanceof ProviderHttpError && !err.isRetryable) {
          break;
        }
        // Пункт [the-retry-killed-the-record] 2026-09-30 — повтор
        // только если его исход успеет попасть в базу.
        //
        // Раньше здесь решал НОМЕР попытки, и это было решение без
        // фактов: попытка, упёршаяся в свой потолок 45 с, оставляла до
        // предела функции 15 с, а следующая просила снова 45 — то есть
        // повтор гарантированно доводил функцию до обрыва платформой, в
        // котором не исполняется ни один catch и причина провала не
        // записывается НИКУДА. Повтор уничтожал ровно то, ради чего
        // нужен. Теперь решает ОСТАТОК: быстрый отказ (401, 429,
        // обрыв сети) повтор оставляет, истёкший потолок — нет.
        if (!fitsAnotherProviderCall(startedAtMs, Date.now())) {
          this.logger.warn(
            `Job ${jobId}: повтор отменён — до предела функции ${FUNCTION_MAX_DURATION_MS} мс ` +
              `осталось ${msLeftForOutcome(startedAtMs, Date.now())} мс, этого не хватит на ещё один вызов провайдера`,
          );
          break;
        }
        // Экспоненциальная пауза между попытками (500мс, 1с, 2с…) —
        // мгновенный повтор в перегруженный провайдер лишь усугубляет
        // 429. Нулевая в тестах (jest выставляет NODE_ENV=test).
        if (attempt < maxRetries) {
          const backoffMs = process.env.NODE_ENV === 'test' ? 0 : 500 * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    // Fallback по AIJob.fallbackModelVersionId. Аудит 2026-09-02 (AI
    // router), честно: эту ветку СЕЙЧАС НИКТО НЕ АКТИВИРУЕТ — джоба
    // создаётся внутри prepareJob и наружу до завершения execute() не
    // отдаётся, так что «проставить через отдельный update перед
    // вызовом» (прежний текст комментария) невозможно; поле не пишет ни
    // один сервис. Ветка оставлена как работающий механизм под будущий
    // выбор запасного движка (селектор §3.15), а не удалена: столбец в
    // схеме есть, тест на ветку есть, и убирать рабочий код ради
    // строчки — хуже, чем назвать его состояние.
    const job = await this.prisma.aIJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.fallbackModelVersionId) {
      const fallbackVersion = await this.prisma.aIModelVersion.findUnique({
        where: { id: job.fallbackModelVersionId },
        include: { model: { include: { provider: true } } },
      });
      // Тот же бюджет, что у повтора: запасной движок — это ещё одно
      // обращение к провайдеру, и без времени на запись исхода оно
      // стоит столько же, сколько повтор, то есть уничтожает запись.
      if (fallbackVersion && fitsAnotherProviderCall(startedAtMs, Date.now())) {
        try {
          this.logger.warn(`Job ${jobId} falling back to ${fallbackVersion.model.name}`);
          return await this.callAndPersist(jobId, fallbackVersion, request, maxRetries + 1);
        } catch (err) {
          lastError = err;
        }
      }
    }

    this.logger.error(`Job ${jobId} exhausted, last error: ${lastError}`);
    throw new AIRouterExhaustedError(request.taskType, maxRetries);
  }

  private async callAndPersist(
    jobId: string,
    modelVersion: ModelVersionWithProvider,
    request: AIRouterRequest,
    attempt: number,
  ): Promise<AIRouterResult> {
    const provider = modelVersion.model.provider;
    if (!provider.apiEndpoint || !provider.credentialRef) {
      throw new Error(
        `AIProvider "${provider.name}" is missing apiEndpoint/credentialRef — cannot call it`,
      );
    }

    const apiKey = await this.secrets.resolve(provider.credentialRef);
    const client = selectProviderClient(provider.name);

    const params: AIProviderCompletionParams = {
      model: modelVersion.version,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      jsonMode: request.jsonMode,
    };

    // Пункт [json-mode-was-asked-and-dropped] 2026-09-26. Спрашивается
    // ЗДЕСЬ, а не по коду вызывающего: главный промпт приходит из базы
    // (`activePrompt?.template`), и статически он неизвестен. Здесь же
    // известен и выбранный провайдер — то есть это единственное место,
    // где видна вся правда о формате ответа.
    const jsonModeCheck = request.jsonMode
      ? checkJsonMode(provider.name, request.systemPrompt, request.userPrompt)
      : null;
    if (jsonModeCheck?.gap) {
      // WARN, а не отказ: 63 сервиса из 64 просят формат словами и
      // работают, и валить задачу из-за пробела в настройке значило бы
      // сломать то, что сейчас работает. Но и промолчать нельзя —
      // молчание здесь и есть сам дефект.
      this.logger.warn(
        `Задача ${request.taskType}: запрошен jsonMode, но ${jsonModeCheck.gap}`,
      );
    }

    const result = await client.complete(params, {
      apiKey,
      apiEndpoint: provider.apiEndpoint,
    });

    const validationPassed = request.validateOutput ? request.validateOutput(result.text) : true;

    if (!validationPassed) {
      await this.prisma.aIJob.update({
        where: { id: jobId },
        data: { schemaValidation: SchemaValidationResult.FAIL, partialResult: result.text },
      });
      // Каким каналом был задан формат — первое, что нужно оператору при
      // провале валидации, и единственное, чего в этом сообщении не было.
      throw new Error(
        `Output failed validateOutput() check on attempt ${attempt}` +
          (jsonModeCheck ? ` (${jsonModeCheck.note})` : ' (jsonMode не запрашивался)'),
      );
    }

    const inference = await this.prisma.aIInference.create({
      data: {
        output: result.text,
        modelVersionId: modelVersion.id,
        promptVersionId: request.promptVersionId,
        aiJobId: jobId,
        inferenceType: request.taskType,
        confidence: null, // не выдумываем число, если провайдер его не даёт
      },
    });

    await this.prisma.aIJob.update({
      where: { id: jobId },
      data: {
        status: AIJobStatus.COMPLETED,
        schemaValidation: SchemaValidationResult.PASS,
        completedAt: new Date(),
        // Срок аренды снимается вместе с завершением: сторожевая
        // смотрит только на QUEUED/RUNNING, но оставленный срок читался
        // бы как «эта джоба когда-то зависала».
        leaseExpiresAt: null,
      },
    });

    return { aiInferenceId: inference.id, jobId, text: result.text };
  }

  // ─────────────────────────────────────────────────────────────────
  // Пункт [multimodal] §4.4–§4.5 — воркер асинхронной полосы.
  //
  // Наша функция НИКОГДА не ждёт модель: submitQueued ставит задачу
  // провайдеру (background: true, ~1 c), pollRunning забирает статус
  // (~1 c). Ожидание целиком на стороне Google — сколько бы ролик ни
  // считался, в предел одного вызова функции мы укладываемся всегда.
  // (До 2026-09-30 здесь стояло «в maxDuration: 10»: в `vercel.json`
  // уже год 60, и число в комментарии расходилось с числом в конфиге —
  // ровно то, из-за чего предел теперь живёт одной константой в
  // `sync-budget.ts` и сверяется с конфигом проверкой.)
  //
  // AIJob при этом остаётся единицей УЧЁТА, а не ожидания: провенанс
  // (AIInference), телеметрия по taskType, ретраи с fallback,
  // идемпотентность по inputHash — ничего из этого внешняя очередь
  // Google не даёт.
  // ─────────────────────────────────────────────────────────────────

  /** Атомарный забор джоб. SKIP LOCKED ОБЯЗАТЕЛЕН: без него два
   * одновременных срабатывания cron возьмут одну джобу дважды и
   * выставят два счёта провайдеру (ТЗ §4.5). */
  private async claimQueuedJobs(limit: number): Promise<string[]> {
    // Аудит 2026-09-02 (AI router): при заборе выставляется КОРОТКИЙ
    // lease (QUEUED_LEASE_MS), а не двухчасовой потолок ожидания
    // провайдера. Двухчасовой ставится ниже, в submitQueued, ПОСЛЕ того,
    // как задача реально ушла провайдеру. Иначе воркер, упавший между
    // забором и постановкой, оставлял джобу RUNNING без
    // externalInteractionId на два часа, хотя провайдер о ней и не знал.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE ai_jobs SET status = 'RUNNING',
             "leaseExpiresAt" = now() + interval '1 millisecond' * ${QUEUED_LEASE_MS},
             "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM ai_jobs
        WHERE status = 'QUEUED' AND "pendingRequest" IS NOT NULL
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    return rows.map((r) => r.id);
  }

  /** Пункт [freeze-stopped-only-the-hands] 2026-09-25 — заморозка на
   * момент ОТПРАВКИ, а не на момент постановки в очередь. Возвращает
   * причину человеческим текстом или `null`, если отправлять можно.
   * Задача без проекта (разборы уровня человека) заморозке не
   * подвержена: замораживают проект, а не человека. */
  private async projectFrozenSinceEnqueue(payload: PendingRequestPayload): Promise<string | null> {
    if (!payload.projectId) return null;
    const project = await this.prisma.project.findUnique({
      where: { id: payload.projectId },
      select: { frozenAt: true },
    });
    return project?.frozenAt ? FROZEN_JOB_REASON : null;
  }

  /** Пункт [revoked-then-sent] 2026-09-06 — согласие на момент ОТПРАВКИ,
   * а не на момент постановки в очередь.
   *
   * Возвращает причину отказа человеческим текстом (она попадёт в
   * `partialResult` и дойдёт до обработчика завершения) или `null`, если
   * отправлять по-прежнему можно.
   *
   * Проверяются те же две вещи и в том же порядке, что в `prepareJob()`:
   * общее согласие на внешний AI и — только для запросов с аудио
   * пользователя — тройка проверок на выход аудио наружу. Повторять
   * здесь нужно ОБЕ: человек мог отозвать любое из них, и запрет на
   * аудио не эквивалентен запрету на AI вообще. */
  private async consentGoneSinceEnqueue(payload: PendingRequestPayload): Promise<string | null> {
    const hasAi = await this.consent.hasActiveConsent(
      payload.userId,
      ConsentType.EXTERNAL_AI,
      payload.projectId,
    );
    if (!hasAi) {
      return 'запрос отменён: согласие на внешний AI отозвано после постановки задачи в очередь — к провайдеру ничего не отправлялось';
    }

    const hasBlobMedia =
      Array.isArray(payload.userPrompt) &&
      payload.userPrompt.some((b) => b.type === 'media' && b.ref.source === 'blob');
    if (hasBlobMedia) {
      try {
        await this.consent.assertAudioMayLeaveDevice(payload.userId, payload.projectId);
      } catch (err) {
        if (err instanceof ForbiddenException) {
          return `запрос с аудио отменён: разрешение на передачу аудио отозвано после постановки задачи в очередь — файл провайдеру не отправлялся (${err.message})`;
        }
        throw err;
      }
    }
    return null;
  }

  /** QUEUED → постановка задачи провайдеру → RUNNING+externalInteractionId.
   *
   * Окно между POST /interactions и записью externalInteractionId
   * сужено до одного запроса, но не закрыто: упавший ровно здесь воркер
   * оставит задачу у провайдера без ссылки у нас, и сторожевая пометит
   * джобу FAILED. Принятая граница, названная в ТЗ (§4.5), не покрытый
   * риск. */
  async submitQueued(limit = 3): Promise<{ submitted: number; failed: number }> {
    const ids = await this.claimQueuedJobs(limit);
    let submitted = 0;
    let failed = 0;

    for (const jobId of ids) {
      const job = await this.prisma.aIJob.findUniqueOrThrow({
        where: { id: jobId },
        include: { modelVersion: { include: { model: { include: { provider: true } } } } },
      });
      const payload = job.pendingRequest as unknown as PendingRequestPayload | null;

      // ── Пункт [revoked-then-sent] 2026-09-06 ──
      //
      // Согласие проверялось ОДИН раз — в `prepareJob()`, при постановке
      // в очередь. Отправка провайдеру происходит ЗДЕСЬ, и между ними
      // проходит время: lease очереди — пятнадцать минут, а неудачная
      // постановка возвращает джобу в QUEUED (`failOrRequeue`), то есть
      // окно продлевается каждой попыткой.
      //
      // Всё это время человек мог нажать «отозвать согласие» — и экран
      // отзыва обещает ему БЕЗУСЛОВНО: «новых запросов от вашего имени
      // больше не будет». Запрос ниже — именно новый запрос от его
      // имени, и он уходил.
      //
      // ПРОВЕРКА ИМЕННО ЗДЕСЬ, А НЕ ТОЛЬКО ПРИ ОТЗЫВЕ. Отзыв снимает
      // джобы из очереди (см. `ConsentService.revoke`), но между
      // выборкой воркером и этой строкой есть окно, которое отменой не
      // закрыть — джоба уже забрана. Закрыть его можно только здесь, у
      // самого вызова: последнее место, где ещё ничего не отправлено.
      //
      // И ЭТО НЕ РЕТРАЙ. Отозванное согласие не станет активным от
      // повторной попытки — джоба падает СРАЗУ и окончательно, минуя
      // `failOrRequeue`, иначе воркер продолжал бы возвращаться к ней до
      // исчерпания попыток.
      // Пункт [freeze-stopped-only-the-hands] 2026-09-25: заморозка
      // проверяется ЗДЕСЬ ЖЕ и по той же причине, что согласие, — это
      // последнее место, где ещё ничего не отправлено. Проект могли
      // заморозить после постановки задачи в очередь, и тогда деньги
      // ушли бы на проект, который оператор уже остановил.
      const frozen = payload ? await this.projectFrozenSinceEnqueue(payload) : null;
      const revoked = frozen ?? (payload ? await this.consentGoneSinceEnqueue(payload) : null);
      if (revoked) {
        failed++;
        const outcome = await this.failJob(jobId, revoked);
        await this.notifyCompletion(job.taskType, outcome);
        continue;
      }

      try {
        if (!payload) throw new Error('pendingRequest is empty for a claimed job');
        const provider = job.modelVersion.model.provider;
        if (!provider.apiEndpoint || !provider.credentialRef) {
          throw new Error(`AIProvider "${provider.name}" is missing apiEndpoint/credentialRef`);
        }
        const client = selectProviderClient(provider.name);
        if (!isBackgroundCapable(client)) {
          throw new Error(
            `Provider "${provider.name}" does not support background interactions — async lane requires it`,
          );
        }
        const apiKey = await this.secrets.resolve(provider.credentialRef);

        // Разрешение MediaRef → URI только здесь, в момент вызова:
        // подписанный URL живёт в теле запроса к провайдеру и нигде
        // больше (§9.2).
        const resolvedPrompt = await this.resolvePromptMedia(payload.userPrompt);

        // Пункт [json-mode-was-asked-and-dropped] 2026-09-26 — то же,
        // что на синхронном пути, и по той же причине: промпт известен
        // только здесь. Проверяется РАЗРЕШЁННЫЙ промпт — тот самый
        // текст, который уйдёт провайдеру.
        if (payload.jsonMode) {
          const check = checkJsonMode(provider.name, payload.systemPrompt, resolvedPrompt);
          if (check.gap) {
            this.logger.warn(
              `Задача ${job.taskType ?? 'unknown'} (джоба ${jobId}): запрошен jsonMode, но ${check.gap}`,
            );
          }
        }

        const { externalId } = await client.submitBackground(
          {
            model: job.modelVersion.version,
            systemPrompt: payload.systemPrompt,
            userPrompt: resolvedPrompt,
            maxTokens: payload.maxTokens,
            temperature: payload.temperature,
            jsonMode: payload.jsonMode,
          },
          { apiKey, apiEndpoint: provider.apiEndpoint },
        );

        await this.prisma.aIJob.update({
          where: { id: jobId },
          data: {
            externalInteractionId: externalId,
            // Задача у провайдера — теперь ждём его, и lease равен
            // потолку ожидания (см. claimQueuedJobs).
            leaseExpiresAt: new Date(Date.now() + EXTERNAL_INTERACTION_MAX_WAIT_MS),
          },
        });
        submitted++;
      } catch (err) {
        failed++;
        this.logger.warn(`submitQueued: job ${jobId} failed to submit: ${err}`);
        // 4xx (кроме 429) — форма запроса: ретрай той же формы даст тот
        // же ответ, падаем СРАЗУ с сырым телом ответа провайдера в
        // partialResult (первый живой прогон: тело 400-го — единственный
        // источник причины). Транзиентные (429/5xx/сеть) — рекью.
        const outcome =
          err instanceof GeminiApiError && !err.isRetryable
            ? await this.failJob(jobId, failureText('provider-rejected', `запрос отвергнут (HTTP ${err.httpStatus}): ${err.body.slice(0, 1500)}`), 'provider-rejected')
            : await this.failOrRequeue(jobId, payload, `постановка задачи провайдеру не удалась: ${err}`);
        await this.notifyCompletion(job.taskType, outcome);
      }
    }
    return { submitted, failed };
  }

  /** Разрешает media-блоки в URI; текстовые блоки и строку не трогает. */
  private async resolvePromptMedia(
    userPrompt: string | ContentBlock[],
  ): Promise<string | ContentBlock[]> {
    if (!Array.isArray(userPrompt)) return userPrompt;
    // Клиент провайдера получает уже РАЗРЕШЁННЫЕ блоки — но контракт
    // ContentBlock несёт MediaRef, поэтому разрешение подкладывается
    // через закрытое поле, известное GeminiClient (см. gemini-client.ts).
    const resolved: ContentBlock[] = [];
    for (const block of userPrompt) {
      if (block.type === 'media') {
        resolved.push({ ...block, resolved: await this.mediaResolver.resolve(block.ref) });
      } else {
        resolved.push(block);
      }
    }
    return resolved;
  }

  /** RUNNING с externalInteractionId → опрос провайдера → терминальный
   * статус или ждём дальше. Маппинг восьми внешних статусов — ТЗ §4.4. */
  async pollRunning(limit = 10): Promise<{ completed: number; failed: number; waiting: number }> {
    // Аудит 2026-09-02 (AI router). Раньше здесь стоял SELECT … FOR UPDATE
    // SKIP LOCKED вне транзакции: блокировка отпускалась сразу по
    // завершении запроса, и два одновременных срабатывания крона
    // опрашивали одни и те же джобы (двойной GET к провайдеру — лишний,
    // но не двойной счёт; двойная запись результата — уже гонка). Второе:
    // ORDER BY "updatedAt" без её изменения при опросе означало, что при
    // очереди длиннее limit одни и те же старые джобы опрашивались каждый
    // раз, а свежие — никогда. UPDATE … RETURNING с подъёмом updatedAt
    // решает обе задачи одним запросом: кто поднял — тот и опрашивает,
    // а очередь ходит по кругу.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE ai_jobs SET "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM ai_jobs
        WHERE status = 'RUNNING' AND "externalInteractionId" IS NOT NULL
        ORDER BY "updatedAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;

    let completed = 0;
    let failed = 0;
    let waiting = 0;

    for (const { id: jobId } of rows) {
      const job = await this.prisma.aIJob.findUniqueOrThrow({
        where: { id: jobId },
        include: { modelVersion: { include: { model: { include: { provider: true } } } } },
      });
      const payload = job.pendingRequest as unknown as PendingRequestPayload | null;
      const provider = job.modelVersion.model.provider;

      try {
        const client = selectProviderClient(provider.name);
        if (!isBackgroundCapable(client) || !provider.apiEndpoint || !provider.credentialRef) {
          throw new Error(`Provider "${provider.name}" cannot be polled`);
        }
        const apiKey = await this.secrets.resolve(provider.credentialRef);
        const result = await client.fetchBackground(job.externalInteractionId as string, {
          apiKey,
          apiEndpoint: provider.apiEndpoint,
        });

        switch (result.status) {
          case 'queued':
          case 'in_progress':
            waiting++;
            break;
          case 'completed': {
            const text = result.text ?? '';
            const validator = this.outputValidators.get(job.taskType ?? '');
            const valid = validator ? validator(text) : true;
            if (!valid) {
              // Ретрай = НОВАЯ постановка задачи (новый externalInteractionId),
              // не повторный опрос старой (§4.4).
              await this.prisma.aIJob.update({
                where: { id: jobId },
                data: { schemaValidation: SchemaValidationResult.FAIL, partialResult: text },
              });
              // Пункт [failure-spoke-to-the-operator] 2026-09-25: человеку
              // — что делать, оператору — что произошло.
              //
              // Пункт [json-mode-was-asked-and-dropped] 2026-09-26: чем
              // именно был задан формат ответа — и есть диагноз этого
              // провала. Раньше в логе стояло «выход не прошёл валидацию
              // схемы», из чего не следовало ничего.
              //
              // Разрешённый промпт здесь не нужен: разрешение меняет
              // только медиа-блоки, а упоминание формата живёт в
              // текстовых, и они те же.
              const jsonModeCheck = payload?.jsonMode
                ? checkJsonMode(provider.name, payload.systemPrompt, payload.userPrompt)
                : null;
              // Формат не запрошен НИ ОДНИМ каналом — причина известна
              // точно, и она не в материалах человека. Другой текст ему,
              // а не совет искать другой фрагмент.
              const kind: FailureKind = jsonModeCheck?.gap
                ? 'schema-invalid-no-format'
                : 'schema-invalid';
              const outcome = await this.failOrRequeue(
                jobId,
                payload,
                failureText(
                  kind,
                  `выход не прошёл валидацию схемы (${jsonModeCheck?.note ?? 'jsonMode не запрашивался'})`,
                ),
                kind,
              );
              if (outcome.kind === 'failed') failed++;
              await this.notifyCompletion(job.taskType, outcome);
              break;
            }
            const inference = await this.prisma.aIInference.create({
              data: {
                output: text,
                modelVersionId: job.modelVersionId,
                promptVersionId: job.promptVersionId,
                aiJobId: jobId,
                inferenceType: job.taskType ?? 'unknown',
                confidence: null,
              },
            });
            await this.prisma.aIJob.update({
              where: { id: jobId },
              data: {
                status: AIJobStatus.COMPLETED,
                schemaValidation: SchemaValidationResult.PASS,
                completedAt: new Date(),
                pendingRequest: Prisma.DbNull,
                leaseExpiresAt: null,
                // Чистим диагностическую заметку «ожидание: …», если
                // прошлые тики записали транзиентную ошибку опроса.
                partialResult: null,
              },
            });
            completed++;
            await this.notifyCompletion(job.taskType, {
              kind: 'completed',
              jobId,
              aiInferenceId: inference.id,
            });
            break;
          }
          case 'failed':
          case 'cancelled': {
            const outcome = await this.failOrRequeue(
              jobId,
              payload,
              `провайдер завершил задачу со статусом ${result.status}: ${result.error ?? 'без деталей'}`,
            );
            if (outcome.kind === 'failed') failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          case 'budget_exceeded': {
            // Исчерпание квоты — не сбой и не повод для ретрая: новая
            // постановка упрётся в тот же лимит (§9.3).
            const outcome = await this.failJob(
              jobId,
              failureText('provider-budget', 'budget_exceeded у провайдера — суточный лимит ключа исчерпан; платный тариф снимает'),
              'provider-budget',
            );
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          case 'incomplete': {
            const outcome = await this.failJob(
              jobId,
              failureText('provider-incomplete', 'ответ упёрся в max_output_tokens (incomplete) — чинится промптом/длительностью, не ретраем'),
              'provider-incomplete',
            );
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          case 'requires_action': {
            const outcome = await this.failJob(
              jobId,
              failureText('provider-contract', 'провайдер запросил requires_action, которых мы не передаём — контракт разошёлся'),
              'provider-contract',
            );
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          default: {
            const outcome = await this.failJob(jobId, failureText('provider-unknown-status', `неизвестный статус провайдера: ${String(result.status)}`), 'provider-unknown-status');
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
          }
        }
      } catch (err) {
        this.logger.warn(`pollRunning: job ${jobId} poll failed: ${err}`);
        if (err instanceof GeminiApiError && !err.isRetryable) {
          // 4xx (кроме 429) на опросе — не транзиентность, а разошедшийся
          // контракт (плохой id, неверная форма GET). Ждать бессмысленно:
          // до этой правки такая ошибка глоталась как «waiting», и джоба
          // молча висела в RUNNING до истечения 2-часового lease —
          // воспроизведено в первом живом прогоне. Падаем сразу, с телом.
          const outcome = await this.failJob(
            jobId,
            // Сырое тело ответа провайдера — диагностика, её место в
            // логе; человеку оно ничего не объясняет и может нести
            // внутренние подробности.
            failureText('provider-rejected', `опрос задачи отвергнут (HTTP ${err.httpStatus}): ${err.body.slice(0, 1500)}`),
          );
          failed++;
          await this.notifyCompletion(job.taskType, outcome);
        } else {
          // Транзиентная ошибка (429/5xx/сеть) — задача у провайдера
          // жива, попробуем в следующий тик. Терминальность обеспечивает
          // leaseExpiresAt + сторожевая. Но причину ЗАПИСЫВАЕМ в
          // partialResult (статус не меняем): иначе «зависшая» джоба в
          // SQL выглядит как retryCount 0 / reason NULL, и отладка
          // превращается в гадание.
          waiting++;
          await this.prisma.aIJob
            .update({
              where: { id: jobId },
              data: { partialResult: `ожидание: последняя ошибка опроса — ${String(err).slice(0, 1500)}` },
            })
            .catch(() => undefined);
        }
      }
    }

    return { completed, failed, waiting };
  }

  /** Ретрай новой постановкой, пока есть попытки; иначе FAILED. */
  private async failOrRequeue(
    jobId: string,
    payload: PendingRequestPayload | null,
    reason: string | FailureText,
    failureKind?: FailureKind,
  ): Promise<AsyncJobOutcome> {
    const job = await this.prisma.aIJob.findUniqueOrThrow({ where: { id: jobId } });
    const maxRetries = payload?.maxRetries ?? 2;
    if (payload && job.retryCount < maxRetries - 1) {
      await this.prisma.aIJob.update({
        where: { id: jobId },
        data: {
          status: AIJobStatus.QUEUED,
          retryCount: { increment: 1 },
          externalInteractionId: null,
          leaseExpiresAt: new Date(Date.now() + QUEUED_LEASE_MS),
          // Причина рекью — в partialResult: без неё джоба между
          // попытками выглядит в SQL как «висит без причины».
          // Пункт [failure-spoke-to-the-operator] 2026-09-25: между
          // попытками задача человеку не показывается (она ещё в
          // работе), поэтому здесь уместна операторская подробность —
          // она и нужна тому, кто смотрит в SQL.
          partialResult: `ретрай новой постановкой: ${(typeof reason === 'string' ? reason : reason.operator).slice(0, 1500)}`,
        },
      });
      return { kind: 'waiting', jobId };
    }
    return this.failJob(jobId, reason, failureKind);
  }

  /** Пункт [failure-spoke-to-the-operator] 2026-09-25: в `partialResult`
   * уходит текст ДЛЯ ЧЕЛОВЕКА — его читает экран. Операторская
   * подробность пишется в лог рядом с идентификатором задачи и наружу
   * не выходит. Раньше здесь была одна строка на обоих, написанная для
   * оператора. */
  private async failJob(jobId: string, text: FailureText | string, failureKind?: FailureKind): Promise<AsyncJobOutcome> {
    const pair: FailureText = typeof text === 'string' ? { person: text, operator: text } : text;
    if (pair.operator !== pair.person) {
      this.logger.warn(`AI-задача ${jobId} провалена: ${pair.operator}`);
    }
    const outcome = await this.failJobWithText(jobId, pair.person);
    return outcome.kind === 'failed' && failureKind ? { ...outcome, failureKind } : outcome;
  }

  private async failJobWithText(jobId: string, reason: string): Promise<AsyncJobOutcome> {
    await this.prisma.aIJob.update({
      where: { id: jobId },
      data: {
        status: AIJobStatus.FAILED,
        completedAt: new Date(),
        partialResult: reason,
        pendingRequest: Prisma.DbNull,
        leaseExpiresAt: null,
      },
    });
    return { kind: 'failed', jobId, reason };
  }

  /** Сторожевая (§4.5): протухший lease → FAILED, отдельными
   * сообщениями для QUEUED (воркер не поставил задачу) и RUNNING
   * (провайдер не ответил за EXTERNAL_INTERACTION_MAX_WAIT_MS). */
  async reapExpired(): Promise<{ reaped: number; reapFailed: number }> {
    // Пункт [background-jobs] 2026-09-04 — потолок порции и устойчивость
    // к одной упавшей строке. Выборка была неограниченной, а
    // notifyCompletion() ходит наружу (сообщение в Telegram): один отказ
    // выбрасывал исключение из всего тика, и джобы, стоявшие в списке
    // после сбойной, оставались непомеченными — не «сторожевая не
    // справилась», а «сторожевая как будто ничего не нашла». Порядок по
    // сроку истечения: первым разбирается то, что зависло дольше.
    const expired = await this.prisma.aIJob.findMany({
      where: {
        status: { in: [AIJobStatus.QUEUED, AIJobStatus.RUNNING] },
        leaseExpiresAt: { lt: new Date() },
      },
      // pendingRequest различает полосы и уже несёт эту роль в коде:
      // воркер забирает только `QUEUED AND "pendingRequest" IS NOT
      // NULL`, а обнуляется поле лишь при завершении. Значит у живой
      // джобы непустое поле = асинхронная полоса, пустое = синхронная.
      select: { id: true, status: true, taskType: true, pendingRequest: true },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
      take: REAP_BATCH,
    });
    let reaped = 0;
    let reapFailed = 0;
    for (const job of expired) {
      // Пункт [the-retry-killed-the-record] 2026-09-30 — третья
      // причина. Синхронную полосу сторожевая раньше не видела вообще
      // (срок аренды у неё не выставлялся), и, начав видеть, назвала бы
      // её причинами асинхронной: «воркер не поставил задачу» про
      // полосу без воркера — это отправить оператора проверять
      // pg_cron-джобы, которые тут ни при чём.
      // Сравнение покрывает и undefined: живая джоба асинхронной полосы
      // без сериализованного запроса невозможна (воркер забирает только
      // `pendingRequest IS NOT NULL`), поэтому «нет значения» в любом
      // виде означает синхронную полосу, а не «не выбрали поле».
      const syncLane = job.pendingRequest === null || job.pendingRequest === undefined;
      const reason = syncLane
        ? failureText(
            'function-cut-off',
            'функция оборвана платформой до записи исхода (предел одного вызова) — запрос человека не завершён и не помечен; цепочка вызовов этой фичи в предел не укладывается',
          )
        : job.status === AIJobStatus.QUEUED
          ? failureText('worker-never-sent', 'воркер не поставил задачу провайдеру до истечения lease — проверьте pg_cron-джобы ai_jobs')
          : failureText('provider-timeout', 'провайдер не завершил задачу за EXTERNAL_INTERACTION_MAX_WAIT_MS; задача могла остаться у провайдера');
      const operatorKind = syncLane
        ? 'function-cut-off'
        : reason.operator.startsWith('worker-never-sent')
          ? 'worker-never-sent'
          : 'provider-timeout';
      try {
        const outcome = await this.failJob(job.id, reason, operatorKind);
        await this.notifyCompletion(job.taskType, outcome);
        reaped++;
      } catch (err) {
        reapFailed++;
        this.logger.warn(
          `Сторожевая AI-джоб: ${job.id} не удалось закрыть — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { reaped, reapFailed };
  }

  /** Пункт [progress-diagnose] 2026-09-01 — инспекция джобы БЕЗ записи:
   * факты из БД плюс ЖИВОЙ статус интеракции у провайдера (прямой GET
   * мимо крона). Для кнопки «Диагностика»: различает «провайдер честно
   * считает», «готово, но опрос ещё не забрал» и «опрос падает» —
   * по одной строке в ai_jobs это неотличимо. */
  async inspectJob(jobId: string): Promise<{
    jobStatus: AIJobStatus;
    retryCount: number;
    submitted: boolean;
    leaseExpiresAt: Date | null;
    note: string | null;
    providerStatus: string | null;
    providerError: string | null;
  }> {
    const job = await this.prisma.aIJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { modelVersion: { include: { model: { include: { provider: true } } } } },
    });

    let providerStatus: string | null = null;
    let providerError: string | null = null;
    if (job.externalInteractionId) {
      try {
        const provider = job.modelVersion.model.provider;
        const client = selectProviderClient(provider.name);
        if (!isBackgroundCapable(client) || !provider.apiEndpoint || !provider.credentialRef) {
          providerError = `провайдер "${provider.name}" не поддерживает фоновый опрос`;
        } else {
          const apiKey = await this.secrets.resolve(provider.credentialRef);
          const result = await client.fetchBackground(job.externalInteractionId, {
            apiKey,
            apiEndpoint: provider.apiEndpoint,
          });
          providerStatus = result.status;
        }
      } catch (err) {
        providerError = String(err).slice(0, 300);
      }
    }

    return {
      jobStatus: job.status,
      retryCount: job.retryCount,
      submitted: job.externalInteractionId != null,
      leaseExpiresAt: job.leaseExpiresAt,
      note: job.partialResult ? job.partialResult.slice(0, 300) : null,
      providerStatus,
      providerError,
    };
  }

  /** GET /ai-jobs/:id — только свои джобы (§4.4). */
  async getJobForUser(userId: string, jobId: string) {
    const job = await this.prisma.aIJob.findUnique({
      where: { id: jobId },
      include: { inferences: { select: { id: true }, take: 1, orderBy: { createdAt: 'desc' } } },
    });
    if (!job || job.requestUserId !== userId) {
      return null;
    }
    return {
      id: job.id,
      status: job.status,
      taskType: job.taskType,
      aiInferenceId: job.inferences[0]?.id ?? null,
      error: job.status === AIJobStatus.FAILED ? job.partialResult : null,
    };
  }

  /** Пункт [idempotency] 2026-09-01 — свежий COMPLETED-результат того
   * же пользователя с тем же inputHash внутри окна. validateOutput
   * вызвавшего прогоняется и по переиспользуемому тексту — если новый
   * вызов строже прежнего, честно идём за свежим выводом. */
  private async findReusableResult(
    request: AIRouterRequest,
    inputHash: string,
    modelVersionId: string,
  ): Promise<AIRouterResult | null> {
    // Пункт [ceilings-nobody-was-told-about] 2026-09-24: разбор значения
    // — общий (`common/spend-limits.ts`), проверка на валидность там же.
    const minutes = spendLimit('AI_IDEMPOTENCY_WINDOW_MINUTES');
    if (minutes === 0) return null;

    const since = new Date(Date.now() - minutes * 60 * 1000);
    const done = await this.prisma.aIJob.findFirst({
      where: {
        inputHash,
        modelVersionId,
        requestUserId: request.userId,
        status: AIJobStatus.COMPLETED,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      include: { inferences: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const inference = done?.inferences?.[0];
    if (!done || !inference) return null;
    if (request.validateOutput && !request.validateOutput(inference.output)) return null;

    this.logger.log(`Idempotent reuse: job ${done.id} for identical request within window`);
    return { jobId: done.id, aiInferenceId: inference.id, text: inference.output };
  }

  private async assertUnderDailyAiLimit(userId: string): Promise<void> {
    // Пункт [ceilings-nobody-was-told-about] 2026-09-24: чтение и
    // умолчание — из реестра `common/spend-limits.ts`, чтобы число не
    // жило в двух местах и попадало в документацию само.
    const limit = spendLimit('AI_CALLS_PER_USER_PER_DAY');
    if (limit === 0) return; // явное отключение
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.aIJob.count({
      where: { requestUserId: userId, createdAt: { gte: since } },
    });
    if (count >= limit) {
      // 429, не Forbidden: лимит временной, не правовой — клиент может
      // повторить завтра; текст без цифр внутренних счётчиков.
      throw new HttpException(
        `Достигнут суточный лимит AI-вызовов (${limit}/сутки). Попробуйте позже.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Суточный потолок медиа-задач на пользователя (env
   * AI_MEDIA_CALLS_PER_USER_PER_DAY, дефолт 20; 0 = выключено). Счёт по
   * taskType текущего запроса: у медиа-задач свои типы (media-public-
   * review, paralinguistics…), отдельного столбца «медиа» у AIJob нет, и
   * заводить его ради счётчика — лишняя миграция. */
  private async assertUnderDailyMediaLimit(userId: string, taskType: string): Promise<void> {
    const limit = spendLimit('AI_MEDIA_CALLS_PER_USER_PER_DAY');
    if (limit === 0) return;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.aIJob.count({
      where: { requestUserId: userId, taskType, createdAt: { gte: since } },
    });
    if (count >= limit) {
      throw new HttpException(
        `Достигнут суточный лимит медиа-разборов (${limit}/сутки). Попробуйте позже.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private hashInput(request: AIRouterRequest): string {
    // Пункт [idempotency] 2026-09-01: хэш поднят с самодельного
    // 32-битного до sha256 — раньше он был просто меткой (нигде не
    // читался), теперь по нему ВОЗВРАЩАЕТСЯ готовый результат, и
    // коллизия означала бы чужой ответ пользователю. В хэш входят ВСЕ
    // поля, влияющие на выход (промпты, потолок токенов, температура,
    // jsonMode, версия промпта) — не только текст.
    //
    // Пункт [multimodal] §10.1: для ContentBlock[] хэш стабилен ИМЕННО
    // потому, что блоки несут MediaRef (videoId/pathname), а не
    // подписанный URL — подпись менялась бы при каждом presign и
    // убивала дедупликацию. Разрешение в URL происходит позже, в
    // момент вызова провайдера.
    const raw = JSON.stringify({
      taskType: request.taskType,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      jsonMode: request.jsonMode,
      promptVersionId: request.promptVersionId,
    });
    return createHash('sha256').update(raw).digest('hex');
  }
}
