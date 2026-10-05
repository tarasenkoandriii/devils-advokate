// Пункт 18: DoNotSayService (§3.53 ТЗ) — пятая из 11 фич MVP v2.
//
// §3.53 явно говорит: "информационная гигиена (3.17) уже существовала,
// выносится в самостоятельный явный блок карточки разговора (3.44)".
// Детекция и хранение — та же архитектура, что Turning Points (Пункт
// 15): НОВАЯ Prisma-модель НЕ заводилась — ConversationSignal
// (signalType=SELF_RISK, riskCategory=ESCALATION|LEVERAGE) уже
// существовал с чекпоинта 1 буквально под этот случай (см. комментарий
// схемы "riskCategory=SELF_RISK) анализирует и реплики пользователя").
// "почему" + "более безопасная альтернативная формулировка" — те же
// два текстовых поля, которых не было у ConversationSignal — снова
// переиспользован AIInference + ConversationSignalEvidence, тот же
// паттерн, что уже дважды использован (ArgumentGenerationService,
// TurningPointsService).
//
// КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ TurningPointsService: анализируются ТОЛЬКО
// сегменты транскрипта, где participant.isSelf=true — это фича именно
// про то, что сказал САМ ПОЛЬЗОВАТЕЛЬ (§3.17: "отдельный анализ
// высказываний самого пользователя"), не собеседника.
//
// РЕАЛЬНОЕ ПЕРЕСЕЧЕНИЕ, НАЙДЕННОЕ ДО НАЧАЛА РЕАЛИЗАЦИИ:
// ConversationCardService.get() уже возвращал поле `doNotSay` — но это
// DecisionObjective.doNotSay, РУЧНОЙ список, который пользователь сам
// вписывает при заполнении цели разговора, а НЕ AI-детекция из
// прошлых разговоров, о которой говорит §3.53/§3.17. Это две РАЗНЫЕ
// вещи с похожим названием — обе должны попасть в карточку, явно
// разделены полями (doNotSay — ручной, selfRiskWarnings — AI-детекция
// с обоснованием и альтернативой), не смешаны в одно поле.
//
// "Проактивно, до следующего разговора" (§3.17: "предупреждения
// показываются до, а не после следующего контакта") — реализовано
// через listForProject(), агрегирующий SELF_RISK по ВСЕМ Conversation
// проекта разом, встроенный в ConversationCardService.get() —
// карточка и есть тот самый проактивный пре-разговорный экран (§3.44).

import { BadGatewayException, BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chunkSegments, chunkedAnalysisNotice, estimateMinutes } from '../common/transcript-chunks';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationProcessingStatus, ConversationSignal, ConversationSignalType, SelfRiskCategory } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { allFilled } from '../common/claim-substance';
import { isEnumValue } from '../common/enum-values';
import { activePromptVersion } from '../common/active-prompt-version';

const TASK_TYPE = 'do-not-say-detection';

interface RawDoNotSayItem {
  segmentId: string;
  riskCategory: 'ESCALATION' | 'LEVERAGE';
  why: string;
  saferAlternative: string;
}

export function isValidDoNotSayPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.segmentId === 'string' &&
        isEnumValue(SelfRiskCategory, item.riskCategory) &&
        // Пункт [finding-without-substance] 2026-09-25: «совет без причины»
        // запрещён комментарием ниже по потоку, но проверялся там только для
        // выдуманного сегмента. Пустое why давало ровно такой совет.
        allFilled(item, ['why', 'saferAlternative']),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты анализируешь ТОЛЬКО реплики САМОГО ПОЛЬЗОВАТЕЛЯ (не собеседника) из транскрипта разговора, с указанием id реплики. Найди высказывания пользователя, которые могут быть невыгодны в будущем: (1) ESCALATION — может эскалировать конфликт, если прозвучит повторно или дойдёт до третьих лиц; (2) LEVERAGE — может быть использовано во вред: как рычаг давления, повод для встречного обвинения, основание для обвинения в противоречии самому себе. Для каждого найденного высказывания укажи id реплики (segmentId), категорию риска, краткое объяснение риска без запугивания (why) и более безопасную альтернативную формулировку той же мысли (saferAlternative). Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "riskCategory": "ESCALATION"|"LEVERAGE", "why": string, "saferAlternative": string}. Если рискованных высказываний нет — верни пустой массив []. Без пояснений вне JSON.';

@Injectable()
export class DoNotSayService {
  private readonly logger = new Logger(DoNotSayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (conversation.status !== ConversationProcessingStatus.TRANSCRIBED &&
        conversation.status !== ConversationProcessingStatus.ANALYZED) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before Do-Not-Say detection (current: ${conversation.status})`,
      );
    }

    const allSegments = conversation.transcript?.segments ?? [];
    // §3.17 ТЗ: только реплики САМОГО пользователя, не собеседника.
    const selfSegments = allSegments.filter((s: any) => s.participant?.isSelf === true);
    if (selfSegments.length === 0) {
      throw new BadRequestException(
        `Conversation ${conversationId} has no segments attributed to the user (isSelf participant) — nothing to analyze`,
      );
    }

    const activePrompt = await activePromptVersion(this.prisma, TASK_TYPE);
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    // Сверка «ссылка на реплику» 2026-09-04: здесь реплики уходят модели
    // с НАСТОЯЩИМ id, а не с коротким номером, — и это решение, а не
    // недосмотр. Номер экономил бы 25 символов на реплику, но ответ
    // модели хранится дословно в `AIInference.output` и перечитывается
    // позже (`list()` восстанавливает из него описание находки, сопоставляя
    // ссылку с сигналом). Номер осмыслен только относительно того списка
    // реплик, который был в ТОМ вызове: после повторной расшифровки или
    // добавления реплик та же цифра указала бы на другую фразу — и
    // объяснение молча приехало бы к чужим словам. Переписывать же
    // сохранённый ответ модели «исправленным» нельзя: это запись о том,
    // что модель сказала на самом деле. Экономия взята там, где ссылка
    // разрешается один раз и хранится уже разрешённой (доменные разборы).
    // Сверка длинных разговоров 2026-09-04: находка этого детектора живёт
    // внутри одной реплики самого пользователя, поэтому разбивка её не
    // портит (граница разобрана в transcript-chunks.ts).
    const renderLine = (s: any) => `[${s.id}] ${s.text}`;
    const chunks = chunkSegments(selfSegments as any[], renderLine);
    const totalChars = (selfSegments as any[]).reduce((n: number, s: any) => n + s.text.length, 0);

    const rawItems: Array<RawDoNotSayItem & { inferenceId: string }> = [];
    try {
      for (const chunk of chunks) {
        const result = await this.aiRouter.execute({
          userId,
          projectId: conversation.projectId,
          taskType: TASK_TYPE,
          promptVersionId: activePrompt?.id,
          systemPrompt,
          userPrompt: chunk.map(renderLine).join('\n'),
          jsonMode: true,
          maxTokens: 1500,
          validateOutput: isValidDoNotSayPayload,
        });
        for (const item of JSON.parse(result.text) as RawDoNotSayItem[]) {
          rawItems.push({ ...item, inferenceId: result.aiInferenceId });
        }
      }
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого транскрипта.');
      }
      throw new BadGatewayException(
        'Не удалось проверить информационную гигиену — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const segmentById = new Map(selfSegments.map((s: any) => [s.id, s]));

    // Сверка молчаливых пропусков 2026-09-04: выдуманный моделью id

    // реплики означает потерянную находку, и раньше она исчезала

    // молча. `ParalinguisticsService` такие случаи СЧИТАЕТ и пишет

    // предупреждение — приём в проекте был, просто не везде. Число в

    // логе не заменяет находку, но делает потерю видимой тому, кто

    // разбирается, почему находок меньше ожидаемого.

    let invented = 0;

    const created: Array<ConversationSignal & { segment: (typeof allSegments)[number]; why: string; saferAlternative: string }> = [];
    for (const item of rawItems) {
      const segment: any = segmentById.get(item.segmentId);
      if (!segment) {
        invented++;
        continue;
      } // AI сослался на несуществующий/чужой сегмент — пропускаем, не падаем на всём батче

      // Сверка «половины операции» 2026-09-04: находка и её основание —
      // одна запись, а не две. Здесь находка о самом пользователе («это
      // лучше не говорить»), и без основания она превращается в совет без
      // причины — ровно то, чего продукт обещает не делать.
      const signal = await this.prisma.$transaction(async (tx) => {
        const s = await tx.conversationSignal.create({
          data: {
            signalType: ConversationSignalType.SELF_RISK,
            transcriptSegmentId: segment.id,
            participantId: segment.participantId,
            riskCategory: item.riskCategory as SelfRiskCategory,
          },
        });
        await tx.conversationSignalEvidence.create({
          data: { conversationSignalId: s.id, aiInferenceId: item.inferenceId },
        });
        return s;
      });
      created.push({ ...signal, segment, why: item.why, saferAlternative: item.saferAlternative });
    }

    // Тот же приём, что уже стоит у `ParalinguisticsService`: пропуск с

    // подсчётом и одним предупреждением. Число не заменяет потерянную

    // находку, но делает потерю видимой — иначе «находок меньше» и

    // «находок нет» выглядят одинаково.

    if (invented > 0) {

      this.logger.warn(

        `DoNotSay для разговора ${conversationId}: модель сослалась на ${invented} несуществующих реплик — эти находки не сохранены`,

      );

    }


    return { points: created, notice: chunkedAnalysisNotice(chunks.length, estimateMinutes(totalChars)) };
  }

  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const all = conversation.transcript?.segments ?? [];
    const segmentIds = all.map((s: any) => s.id);
    // Сверка длинных разговоров 2026-09-04: разбор шёл по репликам САМОГО
    // пользователя, значит и подпись считается по ним же — иначе число
    // частей в подписи не совпало бы с тем, как разбор шёл на самом деле.
    const selfSegments = all.filter((s: any) => s.participant?.isSelf === true);
    const notice = chunkedAnalysisNotice(
      chunkSegments(selfSegments, (s: any) => `[${s.id}] ${s.text}`).length,
      estimateMinutes(selfSegments.reduce((n: number, s: any) => n + s.text.length, 0)),
    );
    if (segmentIds.length === 0) return { points: [], notice: null };
    return { points: await this.querySignals(segmentIds), notice };
  }

  /** §3.17/§3.53 ТЗ: "проактивно, до следующего разговора" — все
   * предупреждения по ВСЕМ разговорам этого проекта разом, для
   * встраивания в ConversationCardService.get() (карточка — и есть
   * тот самый проактивный пре-разговорный экран §3.44). */
  async listForProject(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const segmentIds = (
      await this.prisma.transcriptSegment.findMany({
        where: { transcript: { conversation: { projectId } } },
        select: { id: true },
      })
    ).map((s: { id: string }) => s.id);
    if (segmentIds.length === 0) return [];
    return this.querySignals(segmentIds);
  }

  private async querySignals(segmentIds: string[]) {
    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: ConversationSignalType.SELF_RISK,
        transcriptSegmentId: { in: segmentIds },
      },
      include: {
        transcriptSegment: true,
        evidence: { include: { aiInference: true } },
      },
    });

    return signals.map((signal: any) => {
      const resolved = this.resolveExplanation(signal);
      return { ...signal, why: resolved?.why ?? null, saferAlternative: resolved?.saferAlternative ?? null };
    });
  }

  private resolveExplanation(signal: {
    transcriptSegmentId: string | null;
    evidence: Array<{ aiInference: { output: string } | null }>;
  }): { why: string; saferAlternative: string } | null {
    for (const ev of signal.evidence) {
      if (!ev.aiInference) continue;
      try {
        const parsed: RawDoNotSayItem[] = JSON.parse(ev.aiInference.output);
        const match = parsed.find((p) => p.segmentId === signal.transcriptSegmentId);
        if (match) return { why: match.why, saferAlternative: match.saferAlternative };
      } catch {
        continue; // AIInference.output от другой фичи/не JSON — пропускаем, не падаем
      }
    }
    return null;
  }

  private async findOwnedConversationWithTranscript(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        project: true,
        transcript: { include: { segments: { include: { participant: true } } } },
      },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}
