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

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { ContentScanService } from '../content-scan/content-scan.service';
import {
  AIProviderCompletionParams,
  selectProviderClient,
} from './ai-provider-client';
import {
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
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  validateOutput?: (text: string) => boolean;
  preferredModelVersionId?: string;
  maxRetries?: number;
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
    super(`No active AIModelVersion found with capability for taskType="${taskType}"`);
    this.name = 'AIRouterNoCapableModelError';
  }
}

export class AIRouterContentBlockedError extends Error {
  constructor(reason: string) {
    super(`AI Router blocked the request: ${reason}`);
    this.name = 'AIRouterContentBlockedError';
  }
}

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
  ) {}

  async execute(request: AIRouterRequest): Promise<AIRouterResult> {
    // Закрывает первый TODO: без активного согласия на внешний AI —
    // ForbiddenException, а не тихий вызов. requireConsent() сам решает,
    // проверять ли глобальное согласие или согласие по конкретному
    // проекту — см. ConsentService.hasActiveConsent().
    await this.consent.requireConsent(request.userId, ConsentType.EXTERNAL_AI, request.projectId);

    // Закрывает второй TODO: prompt injection/PII scan перед тем, как
    // текст вообще попадёт в AIJob. Если заблокировано — используем
    // очищенный (или пустой, при блокировке) текст, не сырой ввод.
    const scanOutcome = await this.contentScan.scan({
      text: request.userPrompt,
      targetType: ScanTargetType.AI_JOB_INPUT,
    });
    if (scanOutcome.blocked) {
      throw new AIRouterContentBlockedError(
        'prompt injection pattern detected in userPrompt — request rejected before reaching any AI provider',
      );
    }
    const sanitizedRequest: AIRouterRequest = { ...request, userPrompt: scanOutcome.sanitizedText };

    const modelVersion = await this.resolveModelVersion(
      sanitizedRequest.taskType,
      sanitizedRequest.preferredModelVersionId,
    );

    const inputHash = this.hashInput(sanitizedRequest);
    const maxRetries = sanitizedRequest.maxRetries ?? 2;

    const job = await this.prisma.aIJob.create({
      data: {
        inputHash,
        modelVersionId: modelVersion.id,
        promptVersionId: sanitizedRequest.promptVersionId,
        status: AIJobStatus.QUEUED,
        retryPolicy: `${maxRetries} attempts, then fallback if configured`,
      },
    });

    // Привязываем результат скана к конкретной job постфактум — на
    // момент scan() job ещё не существовала (скан идёт до подбора модели
    // намеренно: не тратим выбор модели на контент, который всё равно
    // будет заблокирован/очищен).
    await this.prisma.contentScanResult.updateMany({
      where: { id: scanOutcome.resultId },
      data: { aiJobId: job.id },
    });

    try {
      return await this.attemptWithRetryAndFallback(job.id, modelVersion, sanitizedRequest, maxRetries);
    } catch (err) {
      await this.prisma.aIJob.update({
        where: { id: job.id },
        data: { status: AIJobStatus.FAILED, completedAt: new Date() },
      });
      throw err;
    }
  }

  /** Подбор модели: явный выбор пользователя > первая active-модель
   * с нужным taskType. Не углубляется в latencyClass/costClass/
   * privacyClass на этом проходе — простейший рабочий вариант; эти
   * критерии добавляются, когда появится первый реальный конфликт
   * между несколькими подходящими моделями (не гадаем сортировку
   * заранее — тот же принцип, что уже применялся в чекпоинте 1
   * к inferenceType/taskType как строкам вместо enum). */
  private async resolveModelVersion(
    taskType: string,
    preferredId?: string,
  ): Promise<ModelVersionWithProvider> {
    if (preferredId) {
      const preferred = await this.prisma.aIModelVersion.findUnique({
        where: { id: preferredId },
        include: { model: { include: { provider: true } } },
      });
      if (!preferred) {
        throw new AIRouterNoCapableModelError(taskType);
      }
      return preferred;
    }

    const capability = await this.prisma.aIModelCapability.findFirst({
      where: { taskType, availability: 'active' },
      include: {
        modelVersion: { include: { model: { include: { provider: true } } } },
      },
    });
    if (!capability) {
      throw new AIRouterNoCapableModelError(taskType);
    }
    return capability.modelVersion;
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

  private hashInput(request: AIRouterRequest): string {
    // Простой детерминированный хэш для идемпотентности (implementation-ready §7)
    // — не криптографический, только для дедупликации повторных запросов.
    const raw = JSON.stringify({
      taskType: request.taskType,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
    });
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = (hash * 31 + raw.charCodeAt(i)) | 0;
    }
    return `h${hash}`;
  }
}
