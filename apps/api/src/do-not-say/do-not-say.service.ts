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

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationProcessingStatus, ConversationSignal, ConversationSignalType, SelfRiskCategory } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'do-not-say-detection';

interface RawDoNotSayItem {
  segmentId: string;
  riskCategory: 'ESCALATION' | 'LEVERAGE';
  why: string;
  saferAlternative: string;
}

function isValidDoNotSayPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.segmentId === 'string' &&
        (item.riskCategory === 'ESCALATION' || item.riskCategory === 'LEVERAGE') &&
        typeof item.why === 'string' &&
        typeof item.saferAlternative === 'string',
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты анализируешь ТОЛЬКО реплики САМОГО ПОЛЬЗОВАТЕЛЯ (не собеседника) из транскрипта разговора, с указанием id реплики. Найди высказывания пользователя, которые могут быть невыгодны в будущем: (1) ESCALATION — может эскалировать конфликт, если прозвучит повторно или дойдёт до третьих лиц; (2) LEVERAGE — может быть использовано во вред: как рычаг давления, повод для встречного обвинения, основание для обвинения в противоречии самому себе. Для каждого найденного высказывания укажи id реплики (segmentId), категорию риска, краткое объяснение риска без запугивания (why) и более безопасную альтернативную формулировку той же мысли (saferAlternative). Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "riskCategory": "ESCALATION"|"LEVERAGE", "why": string, "saferAlternative": string}. Если рискованных высказываний нет — верни пустой массив []. Без пояснений вне JSON.';

@Injectable()
export class DoNotSayService {
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

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    const userPrompt = selfSegments.map((s: any) => `[${s.id}] ${s.text}`).join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidDoNotSayPayload,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого транскрипта.');
      }
      throw new BadGatewayException(
        'Не удалось проверить информационную гигиену — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const rawItems: RawDoNotSayItem[] = JSON.parse(result.text);
    const segmentById = new Map(selfSegments.map((s: any) => [s.id, s]));

    const created: Array<ConversationSignal & { segment: (typeof allSegments)[number]; why: string; saferAlternative: string }> = [];
    for (const item of rawItems) {
      const segment: any = segmentById.get(item.segmentId);
      if (!segment) continue; // AI сослался на несуществующий/чужой сегмент — пропускаем, не падаем на всём батче

      const signal = await this.prisma.conversationSignal.create({
        data: {
          signalType: ConversationSignalType.SELF_RISK,
          transcriptSegmentId: segment.id,
          participantId: segment.participantId,
          riskCategory: item.riskCategory as SelfRiskCategory,
        },
      });
      await this.prisma.conversationSignalEvidence.create({
        data: { conversationSignalId: signal.id, aiInferenceId: result.aiInferenceId },
      });
      created.push({ ...signal, segment, why: item.why, saferAlternative: item.saferAlternative });
    }

    return created;
  }

  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segmentIds = (conversation.transcript?.segments ?? []).map((s: any) => s.id);
    if (segmentIds.length === 0) return [];
    return this.querySignals(segmentIds);
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
