// Пункт 91: MaterialChatService (§3.27 ТЗ, "голосовой чат с AI") —
// единственный реально открытый и посильный кусок §3.27, по прямому
// запросу. Подробное архитектурное обоснование (параллельный, не
// переиспользованный паттерн от SparringService; переиспользованный
// generic SparringVoiceReplyStatus) — см. schema.prisma над
// MaterialChatSession.
//
// AI — СОВМЕСТНЫЙ ПОМОЩНИК, НЕ ОППОНЕНТ. Ключевое смысловое отличие
// от SparringService: "AI задаёт уточняющие вопросы и помогает
// довести промпт... до более детального и конкретного вида"
// (buкально ТЗ) — не состязательная роль-игра. Каждый ответ AI несёт
// ДВЕ вещи: разговорную реплику (вопрос/комментарий) И, опционально,
// обновлённый черновик промпта на правки — AI сам решает, достаточно
// ли уже деталей для обновления черновика, не обязан обновлять его в
// каждом ходу.
//
// ПЕРВОИСТОЧНИК МАТЕРИАЛА НЕ ПЕРЕДАЁТСЯ И ЗДЕСЬ — контекст строится
// только из уже сохранённых WorkingMaterial/MaterialVersion полей
// (title, критика, editPrompt последней версии) — тот же принцип
// locality, что во всём §3.27.

import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import type { ParsedTranscript } from '../conversations/transcription.service';
import { SttService, sttJobIdVariants } from '../stt/stt.service';
import { parseSttWebhookPayload } from '../stt/stt-webhook-payload';
import { isUnknownEnumValueError, warnEnumMigrationLagOnce } from '../common/enum-migration-lag';
import type { SttProviderName } from '../stt/stt-language';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { MaterialChatMessageRole, SparringSessionStatus, SparringVoiceReplyStatus } from '@prisma/client';
import { publicApiBaseUrl } from '../common/public-base-url';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'material-chat';
const MAX_MESSAGES_PER_SESSION = 40; // тот же потолок, что у спарринга (Пункт 55) — та же цена растущей истории в каждом вызове
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — тот же дефолт-голос, что у спарринга вне архетипов (Пункт 69), не придуманное значение

interface RawAssistantReply {
  message: string;
  updatedEditPrompt?: string | null;
}

function isValidAssistantPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.message === 'string' &&
      parsed.message.trim().length > 0 &&
      (parsed.updatedEditPrompt === undefined || parsed.updatedEditPrompt === null || typeof parsed.updatedEditPrompt === 'string')
    );
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Ты — совместный помощник пользователя, НЕ оппонент. Пользователь дорабатывает материал (документ/презентацию) для предстоящего разговора и хочет довести "промпт на правки" (инструкцию для редактирующего AI-инструмента) до конкретного, детального вида. Задавай уточняющие вопросы, помогай пользователю сформулировать мысли точнее. Если пользователь высказал мысль ещё расплывчато — задай уточняющий вопрос, НЕ обновляй updatedEditPrompt. Обновляй updatedEditPrompt (полный, готовый к использованию текст промпта, не фрагмент) ТОЛЬКО когда действительно набралось достаточно конкретики. Отвечай ТОЛЬКО репликой помощника, без пометок "как AI" или подобного — прямая речь. Ответь СТРОГО валидным JSON-объектом вида {"message": string, "updatedEditPrompt": string | null}. Без пояснений вне JSON.';

@Injectable()
export class MaterialChatService {
  private readonly logger = new Logger(MaterialChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly stt: SttService,
    private readonly secrets: SecretsService,
    private readonly textToSpeech: TextToSpeechService,
    private readonly consent: ConsentService,
  ) {}

  async startSession(userId: string, projectId: string, workingMaterialId: string, engineId?: string) {
    const material = await this.findOwnedMaterial(userId, projectId, workingMaterialId);

    const contextPrompt = this.buildMaterialContext(material);
    const userPrompt = [
      contextPrompt,
      'Начни диалог: задай первый уточняющий вопрос, который поможет довести промпт на правки до более конкретного вида.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const assistantMessage = await this.callAssistant(userId, projectId, userPrompt, engineId);
    const audio = await this.synthesizeAssistantAudio(userId, assistantMessage.text, DEFAULT_VOICE_ID);

    const session = await this.prisma.materialChatSession.create({
      data: { workingMaterialId, refinedEditPrompt: assistantMessage.updatedEditPrompt ?? null },
    });
    const message = await this.prisma.materialChatMessage.create({
      data: {
        sessionId: session.id,
        role: MaterialChatMessageRole.ASSISTANT,
        text: assistantMessage.text,
        audioBase64: audio,
        generatedByInferenceId: assistantMessage.aiInferenceId,
      },
    });

    return { ...session, messages: [message] };
  }

  async reply(userId: string, sessionId: string, userText: string, engineId?: string) {
    const session = await this.findOwnedSession(userId, sessionId);
    if (session.status !== SparringSessionStatus.ACTIVE) {
      throw new BadRequestException(`MaterialChatSession ${sessionId} is already ended`);
    }
    if (!userText.trim()) {
      throw new BadRequestException('userText не может быть пустым');
    }

    const existingMessages = await this.prisma.materialChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    if (existingMessages.length >= MAX_MESSAGES_PER_SESSION) {
      throw new BadRequestException(
        `Достигнут лимит сообщений в сессии (${MAX_MESSAGES_PER_SESSION}) — завершите эту сессию и начните новую`,
      );
    }

    const userMessage = await this.prisma.materialChatMessage.create({
      data: { sessionId, role: MaterialChatMessageRole.USER, text: userText.trim() },
    });

    const material = await this.prisma.workingMaterial.findUniqueOrThrow({
      where: { id: session.workingMaterialId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    const contextPrompt = this.buildMaterialContext(material);

    const historyText = [...existingMessages, userMessage]
      .map((m: { role: string; text: string }) => `${m.role === 'ASSISTANT' ? 'Помощник' : 'Пользователь'}: ${m.text}`)
      .join('\n');

    const currentDraft = session.refinedEditPrompt ? `Текущий черновик промпта на правки:\n${session.refinedEditPrompt}` : '';

    const userPrompt = [contextPrompt, currentDraft, `История диалога до сих пор:\n${historyText}`, 'Дай следующую реплику помощника.']
      .filter(Boolean)
      .join('\n\n');

    const assistantMessage = await this.callAssistant(userId, material.projectId, userPrompt, engineId);
    const audio = await this.synthesizeAssistantAudio(userId, assistantMessage.text, DEFAULT_VOICE_ID);

    const assistantReply = await this.prisma.materialChatMessage.create({
      data: {
        sessionId,
        role: MaterialChatMessageRole.ASSISTANT,
        text: assistantMessage.text,
        audioBase64: audio,
        generatedByInferenceId: assistantMessage.aiInferenceId,
      },
    });

    // "Обновлять только когда действительно набралось достаточно
    // конкретики" — если AI на этом ходу не вернул обновление, черновик
    // честно остаётся прежним, не сбрасывается и не перезаписывается пустотой.
    if (assistantMessage.updatedEditPrompt) {
      await this.prisma.materialChatSession.update({
        where: { id: sessionId },
        data: { refinedEditPrompt: assistantMessage.updatedEditPrompt },
      });
    }

    return [userMessage, assistantReply];
  }

  async endSession(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);
    return this.prisma.materialChatSession.update({
      where: { id: session.id },
      data: { status: SparringSessionStatus.ENDED, endedAt: new Date() },
    });
  }

  async listSessions(userId: string, projectId: string, workingMaterialId: string) {
    await this.findOwnedMaterial(userId, projectId, workingMaterialId);
    return this.prisma.materialChatSession.findMany({
      where: { workingMaterialId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSession(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);
    const messages = await this.prisma.materialChatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    return { ...session, messages };
  }

  private buildMaterialContext(material: {
    title: string;
    projectId?: string;
    versions?: { critique: string; editPrompt: string }[];
  }): string {
    const latestVersion = material.versions?.[0];
    return [
      `Материал: "${material.title}".`,
      latestVersion ? `Последняя критика материала: ${latestVersion.critique}` : '',
      latestVersion ? `Текущий сгенерированный промпт на правки: ${latestVersion.editPrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async callAssistant(
    userId: string,
    projectId: string,
    userPrompt: string,
    engineId?: string,
  ): Promise<{ text: string; updatedEditPrompt: string | null; aiInferenceId?: string }> {
    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 700,
        validateOutput: isValidAssistantPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось получить ответ помощника — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawAssistantReply = JSON.parse(result.text);
    return { text: raw.message, updatedEditPrompt: raw.updatedEditPrompt ?? null, aiInferenceId: result.aiInferenceId };
  }

  /** Та же честная деградация, что synthesizeOpponentAudio() в
   * SparringService (Пункт 90) — сбой синтеза не должен останавливать
   * диалог. */
  private async synthesizeAssistantAudio(userId: string, text: string, voiceId: string): Promise<string | null> {
    try {
      const result = await this.textToSpeech.synthesize(userId, text, voiceId);
      return result.audioBase64;
    } catch {
      return null;
    }
  }

  private async findOwnedMaterial(userId: string, projectId: string, workingMaterialId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const material = await this.prisma.workingMaterial.findFirst({
      where: { id: workingMaterialId, projectId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!material) {
      throw new NotFoundException(`WorkingMaterial ${workingMaterialId} not found in project ${projectId}`);
    }
    return { ...material, projectId };
  }

  private async findOwnedSession(userId: string, sessionId: string) {
    const session = await this.prisma.materialChatSession.findUnique({
      where: { id: sessionId },
      include: { workingMaterial: { include: { project: true } } },
    });
    if (!session || session.workingMaterial.project.ownerId !== userId) {
      throw new NotFoundException(`MaterialChatSession ${sessionId} not found`);
    }
    return session;
  }

  // ═══════════════════════ голосовой ввод реплики — параллельный паттерн Пункта 69 ═══════════════════════

  async streamUploadVoiceReply(userId: string, sessionId: string, fileStream: ReadableStream<Uint8Array>, contentType?: string | null) {
    const session = await this.findOwnedSession(userId, sessionId);
    // ПОВТОРНЫЙ АУДИТ 2026-08-30 — см. тот же комментарий в
    // SparringService: модуль не проверял ни режим приватности, ни
    // согласия, хотя отправляет голос пользователя внешнему провайдеру.
    await this.consent.assertAudioMayLeaveDevice(userId, session.workingMaterial.projectId);
    // Пункт [stt-multi] 2026-09-02 — байты уходят провайдеру языка.
    const { audioUrl, provider } = await this.stt.uploadAudio(fileStream, await this.userLanguage(userId), contentType ?? null);
    return { audioUrl, sttProvider: provider };
  }

  async submitVoiceReply(userId: string, sessionId: string, audioUrl: string, sttProvider?: SttProviderName) {
    const session = await this.findOwnedSession(userId, sessionId);
    await this.consent.assertAudioMayLeaveDevice(userId, session.workingMaterial.projectId);
    if (session.status !== SparringSessionStatus.ACTIVE) {
      throw new BadRequestException(`MaterialChatSession ${sessionId} is already ended`);
    }
    const existingCount = await this.prisma.materialChatMessage.count({ where: { sessionId } });
    if (existingCount >= MAX_MESSAGES_PER_SESSION) {
      throw new BadRequestException(
        `Достигнут лимит сообщений в сессии (${MAX_MESSAGES_PER_SESSION}) — завершите эту сессию и начните новую`,
      );
    }

    const webhookUrl = this.buildVoiceWebhookUrl();
    const { storedId } = await this.stt.submitWebhookJob({
      audioUrl,
      webhookUrl,
      languageCode: await this.userLanguage(userId),
      diarize: false, // одна реплика одного говорящего
      uploadedTo: sttProvider,
    });

    return this.prisma.materialChatVoiceReplyJob.create({
      data: { materialChatSessionId: sessionId, externalTranscriptionJobId: storedId },
    });
  }

  async getVoiceReplyStatus(userId: string, sessionId: string, jobId: string) {
    await this.findOwnedSession(userId, sessionId);
    const job = await this.prisma.materialChatVoiceReplyJob.findUnique({ where: { id: jobId } });
    if (!job || job.materialChatSessionId !== sessionId) {
      throw new NotFoundException(`MaterialChatVoiceReplyJob ${jobId} not found`);
    }
    return job;
  }

  async handleVoiceReplyWebhook(rawPayload: unknown) {
    // Финальный аудит 2026-08-30 — тот же фикс, что в
    // ConversationsService.handleTranscriptionWebhook(): реальный вебхук
    // несёт только id/status, полный результат — отдельным GET.
    // Пункт [stt-multi] 2026-09-02 — тело разбирает общий парсер:
    // AssemblyAI шлёт transcript_id, Soniox — id.
    const payload = parseSttWebhookPayload(rawPayload);
    if (!payload.externalJobId) return;
    const job = await this.prisma.materialChatVoiceReplyJob.findFirst({
      where: { externalTranscriptionJobId: { in: sttJobIdVariants(payload.externalJobId) } },
    });
    if (!job) {
      // Реплика удалена (сессия, проект, аккаунт) до прихода вебхука —
      // результат никому; убираем задачу у провайдера (аудит 2026-09-02).
      await this.stt.discardOrphan(payload.providerHint, payload.externalJobId);
      return;
    }
    if (job.status !== SparringVoiceReplyStatus.PENDING) return;

    // Аудит 2026-09-02 (STT): атомарный забор джобы. Проверка статуса
    // выше — обычное чтение, и между ней и записью COMPLETED проходит
    // ответ AI-оппонента (секунды). Провайдер ретраит вебхук на таймаут
    // нашего ответа, вторая доставка успевала пройти ту же проверку и
    // создавала вторую пару реплик. UPDATE с условием на статус: кто
    // перевёл PENDING → PROCESSING, тот и обрабатывает; второму — count 0.
    // Отставание миграции (значение PROCESSING ещё не в базе) — не отказ
    // реплики: работаем как до правки, с предупреждением в лог один раз.
    try {
      const claimed = await this.prisma.materialChatVoiceReplyJob.updateMany({
        where: { id: job.id, status: SparringVoiceReplyStatus.PENDING },
        data: { status: SparringVoiceReplyStatus.PROCESSING },
      });
      if (claimed.count === 0) return;
    } catch (err) {
      if (!isUnknownEnumValueError(err)) throw err;
      warnEnumMigrationLagOnce(this.logger, 'materialChatVoiceReplyJob.claim');
    }

    let parsed: ParsedTranscript | null = null;
    let failure: string | null = null;
    try {
      parsed = await this.stt.fetchResult(job.externalTranscriptionJobId ?? payload.externalJobId);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (failure !== null || parsed === null) {
      await this.prisma.materialChatVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: failure ?? 'unknown error' },
      });
      return;
    }

    const transcribedText = parsed.segments.map((s) => s.text).join(' ').trim();
    if (!transcribedText) {
      await this.prisma.materialChatVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: 'пустая транскрипция' },
      });
      return;
    }

    const session = await this.prisma.materialChatSession.findUniqueOrThrow({
      where: { id: job.materialChatSessionId },
      include: { workingMaterial: { include: { project: true } } },
    });

    try {
      const [userMessage, assistantReply] = await this.reply(
        session.workingMaterial.project.ownerId,
        job.materialChatSessionId,
        transcribedText,
      );
      await this.prisma.materialChatVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.COMPLETED, userMessageId: userMessage.id, assistantMessageId: assistantReply.id },
      });
    } catch (err) {
      await this.prisma.materialChatVoiceReplyJob.update({
        where: { id: job.id },
        data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: err instanceof Error ? err.message : 'unknown error' },
      });
    }
  }

  /** Язык пользователя — по нему выбирается провайдер распознавания. */
  private async userLanguage(userId: string): Promise<string | null> {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { languageCode: true } });
      return user?.languageCode ?? null;
    } catch {
      return null;
    }
  }

  private buildVoiceWebhookUrl(): string {
    // ПОВТОРНЫЙ АУДИТ 2026-08-30: проверки здесь не было — в отличие от
    // ConversationsService и SparringService, где она есть. Без неё
    // AssemblyAI получал webhook_url вида "undefined/material-chat-..."
    // и задача уходила в работу, результат которой не мог вернуться
    // никогда. Отказ до отправки честнее молчаливо потерянного job'а.
    //
    // 2026-08-31: именно расхождение трёх копий этой проверки и было
    // причиной той дыры, поэтому теперь проверка одна на всех —
    // common/public-base-url.ts. Там же нормализация слэша на конце.
    return `${publicApiBaseUrl()}/material-chat-sessions/voice-reply-webhook`;
  }
}
