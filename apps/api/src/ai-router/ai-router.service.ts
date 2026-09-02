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

import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { ContentScanService } from '../content-scan/content-scan.service';
import {
  AIProviderCompletionParams,
  ContentBlock,
  requiresMedia,
  selectProviderClient,
  isProviderClientRegistered,
  EXTERNAL_INTERACTION_MAX_WAIT_MS,
  ProviderHttpError,
} from './ai-provider-client';
import { MediaUriResolverService } from './media-uri-resolver.service';
import {
  DEFAULT_AI_RESPONSE_LANGUAGE,
  normalizeLanguageCode,
  withResponseLanguage,
} from '../common/ai-response-language';
import { isBackgroundCapable, GeminiApiError } from './gemini-client';
import {
  Prisma,
  AIJobStatus,
  SchemaValidationResult,
  ConsentType,
  ScanTargetType,
} from '@prisma/client';

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
  constructor(taskType: string) {
    // Пункт [router-simplify] 2026-09-01: причин ровно две, и обе — про
    // конфигурацию, а не про провайдера. Точную (нет строк / нет ключа,
    // и у кого именно) пишет resolveModelVersion в лог; здесь — общий
    // текст, который видит вызывающий код.
    super(
      `Нет модели, которой можно отдать задачу "${taskType}": либо в базе нет активных ` +
        'AIModelCapability (выполните prisma:seed), либо ни у одной активной модели не задан ключ провайдера',
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
  | { kind: 'failed'; jobId: string; reason: string }
  | { kind: 'waiting'; jobId: string };

type ModelVersionWithProvider = {
  id: string;
  version: string;
  model: {
    name: string;
    provider: { name: string; apiEndpoint: string | null; credentialRef: string | null };
  };
};

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

    const prepared = await this.prepareJob(request, true);
    if (prepared.reused) {
      return prepared.reused;
    }

    try {
      return await this.attemptWithRetryAndFallback(
        prepared.job!.id,
        prepared.modelVersion,
        prepared.sanitizedRequest,
        prepared.maxRetries,
      );
    } catch (err) {
      await this.prisma.aIJob.update({
        where: { id: prepared.job!.id },
        data: { status: AIJobStatus.FAILED, completedAt: new Date() },
      });
      throw err;
    }
  }

  /** Пункт [multimodal] §4.4 — асинхронная постановка. Тот же пролог,
   * что execute() (общий prepareJob — дублирования нет намеренно),
   * но вместо вызова провайдера джоба остаётся QUEUED с сериализованным
   * запросом; исполняет её воркер (submitQueued/pollRunning). */
  async enqueue(request: AIRouterRequest): Promise<{ jobId: string }> {
    const prepared = await this.prepareJob(request);

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

  /** Общий пролог execute()/enqueue() — ТЗ §4.4 требует именно общий
   * метод, а не копию: копия проверки в каждой точке — способ
   * разъехаться, уже дважды стоивший дыр (см. ConsentService). */
  private async prepareJob(request: AIRouterRequest, allowReuse = false) {
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
    if (allowReuse) {
      const reused = await this.findReusableResult(sanitizedRequest, inputHash);
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
        retryPolicy: `${maxRetries} attempts, then fallback if configured`,
        // Владелец запроса — для GET /ai-jobs/:id («только свои
        // джобы»). Поле добавлено сверх списка ТЗ §4.3 ровно потому,
        // что без него требование §4.4 о проверке владения выполнить
        // нечем: pendingRequest обнуляется при завершении.
        requestUserId: sanitizedRequest.userId,
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
    const user = await this.prisma.user.findUnique({
      where: { id: request.userId },
      select: { languageCode: true },
    });
    return normalizeLanguageCode(user?.languageCode) ?? DEFAULT_AI_RESPONSE_LANGUAGE;
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
    preferredId?: string,
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
    const candidates = rows.filter((c) => isProviderClientRegistered(c.modelVersion.model.provider.name));
    const withoutClient = rows
      .filter((c) => !isProviderClientRegistered(c.modelVersion.model.provider.name))
      .map((c) => c.modelVersion.model.provider.name);
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
        throw new AIRouterNoCapableModelError(taskType);
      }
      if (!(await this.hasUsableKey(preferred.modelVersion.model.provider))) {
        throw new AIRouterNoCapableModelError(taskType);
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
    this.logger.error(
      candidates.length === 0
        ? `Нет активных моделей${needsMedia ? ' с поддержкой медиа' : ''} для задачи ${taskType}: ` +
            'в базе нет строк AIModelCapability — выполните `npm run prisma:seed`'
        : `Ни у одной активной модели нет ключа (задача ${taskType}): ${withoutKey.join(', ')}`,
    );
    throw new AIRouterNoCapableModelError(taskType);
  }

  /** Ключ провайдера реально доступен в окружении. Ровно этот вопрос
   *  раньше не задавался: роутер брал первую настроенную модель и падал
   *  на 401 у провайдера, чьего ключа в проекте нет вообще. */
  private async hasUsableKey(provider: { apiEndpoint: string | null; credentialRef: string | null }): Promise<boolean> {
    if (!provider.apiEndpoint || !provider.credentialRef) return false;
    try {
      await this.secrets.resolve(provider.credentialRef);
      return true;
    } catch {
      return false;
    }
  }

  private async attemptWithRetryAndFallback(
    jobId: string,
    modelVersion: ModelVersionWithProvider,
    request: AIRouterRequest,
    maxRetries: number,
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
        // Экспоненциальная пауза между попытками (500мс, 1с, 2с…) —
        // мгновенный повтор в перегруженный провайдер лишь усугубляет
        // 429. Нулевая в тестах (jest выставляет NODE_ENV=test).
        if (attempt < maxRetries) {
          const backoffMs = process.env.NODE_ENV === 'test' ? 0 : 500 * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    // Fallback — если на самой job-записи заранее проставлен
    // fallbackModelVersionId (вызывающий код может проставить его через
    // отдельный update перед вызовом execute(), если знает подходящую
    // альтернативу — например движок, выбранный пользователем как запасной).
    const job = await this.prisma.aIJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.fallbackModelVersionId) {
      const fallbackVersion = await this.prisma.aIModelVersion.findUnique({
        where: { id: job.fallbackModelVersionId },
        include: { model: { include: { provider: true } } },
      });
      if (fallbackVersion) {
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
      throw new Error(`Output failed validateOutput() check on attempt ${attempt}`);
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
  // считался, в maxDuration: 10 мы укладываемся всегда.
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
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE ai_jobs SET status = 'RUNNING',
             "leaseExpiresAt" = now() + interval '1 millisecond' * ${EXTERNAL_INTERACTION_MAX_WAIT_MS},
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
          data: { externalInteractionId: externalId },
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
            ? await this.failJob(jobId, `провайдер отверг запрос (HTTP ${err.httpStatus}, не ретраится): ${err.body.slice(0, 1500)}`)
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
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ai_jobs
      WHERE status = 'RUNNING' AND "externalInteractionId" IS NOT NULL
      ORDER BY "updatedAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;

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
              const outcome = await this.failOrRequeue(jobId, payload, 'выход не прошёл валидацию схемы');
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
              'исчерпан суточный лимит медиа-анализа провайдера (budget_exceeded) — попробуйте завтра либо перейдите на платный тариф',
            );
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          case 'incomplete': {
            const outcome = await this.failJob(
              jobId,
              'ответ упёрся в max_output_tokens (incomplete) — чинится промптом/длительностью, не ретраем',
            );
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          case 'requires_action': {
            const outcome = await this.failJob(
              jobId,
              'провайдер запросил tool-действие (requires_action), которых мы не передаём — контракт разошёлся',
            );
            failed++;
            await this.notifyCompletion(job.taskType, outcome);
            break;
          }
          default: {
            const outcome = await this.failJob(jobId, `неизвестный статус провайдера: ${String(result.status)}`);
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
            `провайдер отверг опрос задачи (HTTP ${err.httpStatus}, не ретраится): ${err.body.slice(0, 1500)}`,
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
    reason: string,
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
          partialResult: `ретрай новой постановкой: ${reason.slice(0, 1500)}`,
        },
      });
      return { kind: 'waiting', jobId };
    }
    return this.failJob(jobId, reason);
  }

  private async failJob(jobId: string, reason: string): Promise<AsyncJobOutcome> {
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
  async reapExpired(): Promise<{ reaped: number }> {
    const expired = await this.prisma.aIJob.findMany({
      where: {
        status: { in: [AIJobStatus.QUEUED, AIJobStatus.RUNNING] },
        leaseExpiresAt: { lt: new Date() },
      },
      select: { id: true, status: true, taskType: true },
    });
    for (const job of expired) {
      const reason =
        job.status === AIJobStatus.QUEUED
          ? 'воркер не поставил задачу провайдеру до истечения lease — проверьте pg_cron-джобы ai_jobs'
          : 'провайдер не завершил задачу за отведённый потолок ожидания (EXTERNAL_INTERACTION_MAX_WAIT_MS); задача могла остаться у провайдера';
      const outcome = await this.failJob(job.id, reason);
      await this.notifyCompletion(job.taskType, outcome);
    }
    return { reaped: expired.length };
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
  private async findReusableResult(request: AIRouterRequest, inputHash: string): Promise<AIRouterResult | null> {
    const rawMinutes = Number(process.env.AI_IDEMPOTENCY_WINDOW_MINUTES ?? '10');
    const minutes = Number.isFinite(rawMinutes) && rawMinutes >= 0 ? rawMinutes : 10;
    if (minutes === 0) return null;

    const since = new Date(Date.now() - minutes * 60 * 1000);
    const done = await this.prisma.aIJob.findFirst({
      where: {
        inputHash,
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
    const raw = Number(process.env.AI_CALLS_PER_USER_PER_DAY ?? '300');
    const limit = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 300;
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
