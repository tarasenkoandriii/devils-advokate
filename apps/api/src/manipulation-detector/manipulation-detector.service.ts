// Пункт 36: ManipulationDetectorService (§3.28 ТЗ) — первая из трёх
// фич MVP v3, отобранных как готовые СЕЙЧАС без новой инфраструктуры
// (по итогам явного анализа: "стоит ли выполнять MVP v3 сейчас",
// см. соответствующий раздел этого README).
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ — тот же класс, что уже применялся к Turning
// Points (Пункт 15): НОВАЯ Prisma-модель НЕ заводилась. У детектора
// манипуляций уже было всё нужное с чекпоинта 1:
// ConversationSignal(signalType=MANIPULATION_PATTERN) — этот enum-
// значение существовало в схеме с самого начала, но ни один сервис ни
// разу его не создавал (Turning Points только ЧИТАЕТ его, чтобы
// проверить confirmedGenuinely — см. manipulationSegmentIds в
// turning-points.service.ts) — тот же класс пробела, что уже
// находился раньше (модель/enum есть, сервиса-создателя нет), здесь
// закрыт реализацией.
//
// КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ Do Not Say (Пункт 18, §3.53/§3.17): та фича
// анализирует ТОЛЬКО реплики isSelf-участника (риск для самого
// пользователя). Здесь — ТЗ прямо требует обратное: "распознавание
// работает на ОБОИХ говорящих через диаризацию" (§3.28, "полезный
// побочный эффект... симметрично 3.17") — детектор манипуляций
// анализирует ВСЕ реплики без фильтра по isSelf, включая реплики
// собеседника (основной случай использования) и реплики самого
// пользователя (побочный эффект, явно упомянутый в ТЗ).
//
// "Техника манипуляции" (переход на личности/подмена тезиса/ложная
// дилемма/whataboutism/апелляция к эмоциям/давление на срочность) —
// НЕ отдельное enum-поле схемы (ConversationSignal не имеет
// специального поля под это, в отличие от riskCategory для SELF_RISK
// или severity для FACTUAL_DISCREPANCY) — хранится текстом внутри
// AIInference.output, восстанавливается в list() тем же способом, что
// description у Turning Points, не отдельным полем на каждый сигнал
// ради одного значения на batch-вызов.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { hasPersonVerdict, NO_PERSON_VERDICT_RULE } from '../common/no-person-verdict';
import { PrismaService } from '../prisma/prisma.service';
import { chunkSegments, chunkedAnalysisNotice, estimateMinutes } from '../common/transcript-chunks';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSignal, ConversationSignalType } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { allFilled } from '../common/claim-substance';

const TASK_TYPE = 'manipulation-detection';

interface RawManipulationPoint {
  segmentId: string;
  technique: string; // например "переход на личности", "ложная дилемма" — не enum, см. обоснование в шапке файла
  description: string;
  confidence?: number;
}

/** Пункт [same-line-not-drawn] 2026-09-24. Проверялась только ФОРМА
 * ответа: массив, поля нужных типов. Про содержание — ни слова, при том
 * что `technique` и `description` приходят свободным текстом о реплике
 * НАЗВАННОГО человека. Ответ «собеседник лжёт, типичный нарцисс» форму
 * проходил и записывался.
 *
 * У соседнего разбора, паралингвистики (§7.4), вторая линия была с
 * самого начала: стоп-слова в выходе, попадание — провал валидации и
 * повтор, а не запись сигнала. Здесь её не было, хотя утверждение здесь
 * ПРЯМЕЕ: там описывают темп и паузы, тут называют приём в чужих
 * словах. Теперь линия одна на оба разбора. */
export function isValidManipulationPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    if (hasPersonVerdict(text)) return false;
    return parsed.every(
      (item) =>
        typeof item.segmentId === 'string' &&
        // Пункт [finding-without-substance] 2026-09-25: приём без названия
        // и без описания — утверждение о человеке, которое нечем прочитать.
        allFilled(item, ['technique', 'description']) &&
        (item.confidence === undefined || typeof item.confidence === 'number'),
    );
  } catch {
    return false;
  }
}

export const DEFAULT_SYSTEM_PROMPT =
  'Ты анализируешь транскрипт разговора построчно, с указанием говорящего и id реплики. Найди реплики ЛЮБОГО из говорящих (не только одного конкретного), где используется манипулятивный приём аргументации: переход на личности, подмена тезиса, ложная дилемма, whataboutism (аргумент "а вот ты..."), апелляция к эмоциям вместо сути, давление на срочность. Для каждой найденной реплики укажи: segmentId — id реплики, technique — короткое название приёма на русском, description — конкретно, в чём проявился приём в ЭТОЙ реплике. Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "technique": string, "description": string, "confidence": number от 0 до 1}. Если манипулятивных приёмов нет — верни пустой массив []. Без пояснений вне JSON. ' +
  // Пункт [same-line-not-drawn] 2026-09-24: запрета выводов о личности
  // здесь не было вовсе — при том что у соседнего разбора реплик
  // (паралингвистика, §7.4) он стои́т и в промпте, и в проверке выхода.
  NO_PERSON_VERDICT_RULE;

@Injectable()
export class ManipulationDetectorService {
  private readonly logger = new Logger(ManipulationDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (
      conversation.status !== ConversationProcessingStatus.TRANSCRIBED &&
      conversation.status !== ConversationProcessingStatus.ANALYZED
    ) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before manipulation detection (current: ${conversation.status})`,
      );
    }
    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new BadRequestException(`Разбор невозможен: у этого разговора нет расшифровки. Это не значит, что находок нет — их не искали.`);
    }

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    // Все реплики, оба говорящих — НЕ фильтруется по isSelf (см. обоснование в шапке файла).
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
    // Сверка длинных разговоров 2026-09-04: полтора часа записи не
    // помещались в один запрос, и разбор отказывал совсем. Находка этого
    // детектора живёт ВНУТРИ одной реплики («в этой фразе — подмена
    // тезиса»), поэтому разбивка на части её не портит — см. разбор
    // границы в transcript-chunks.ts.
    const renderLine = (s: (typeof segments)[number]) =>
      `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`;
    const chunks = chunkSegments(segments, renderLine);
    const totalChars = segments.reduce((n: number, s: (typeof segments)[number]) => n + s.text.length, 0);

    const rawPoints: Array<RawManipulationPoint & { inferenceId: string }> = [];
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
          validateOutput: isValidManipulationPayload,
        });
        for (const point of JSON.parse(result.text) as RawManipulationPoint[]) {
          rawPoints.push({ ...point, inferenceId: result.aiInferenceId });
        }
      }
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого транскрипта.');
      }
      throw new BadGatewayException(
        'Не удалось проверить разговор на манипулятивные приёмы — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const segmentById = new Map<string, (typeof segments)[number]>(
      segments.map((s: (typeof segments)[number]): [string, (typeof segments)[number]] => [s.id, s]),
    );

    // Сверка молчаливых пропусков 2026-09-04: выдуманный моделью id

    // реплики означает потерянную находку, и раньше она исчезала

    // молча. `ParalinguisticsService` такие случаи СЧИТАЕТ и пишет

    // предупреждение — приём в проекте был, просто не везде. Число в

    // логе не заменяет находку, но делает потерю видимой тому, кто

    // разбирается, почему находок меньше ожидаемого.

    let invented = 0;

    const created: Array<ConversationSignal & { segment: (typeof segments)[number]; technique: string; description: string }> = [];
    for (const point of rawPoints) {
      const segment = segmentById.get(point.segmentId);
      if (!segment) {
        invented++;
        continue;
      } // AI сослался на несуществующий id реплики — пропускаем, не падаем на всём батче

      // Сверка «половины операции» 2026-09-04: находка и её основание —
      // одна запись, а не две. Сбой между ними оставлял утверждение о
      // человеке без ссылки на то, откуда оно взялось. Транзакция на
      // пару, не на весь батч: остальные валидные находки терять незачем
      // (тот же принцип, что строкой выше про несуществующий id).
      const signal = await this.prisma.$transaction(async (tx) => {
        const s = await tx.conversationSignal.create({
          data: {
            signalType: ConversationSignalType.MANIPULATION_PATTERN,
            transcriptSegmentId: segment.id,
            participantId: segment.participantId,
            confidence: point.confidence ?? null,
          },
        });
        await tx.conversationSignalEvidence.create({
          data: { conversationSignalId: s.id, aiInferenceId: point.inferenceId },
        });
        return s;
      });
      created.push({ ...signal, segment, technique: point.technique, description: point.description });
    }

    // Тот же приём, что уже стоит у `ParalinguisticsService`: пропуск с

    // подсчётом и одним предупреждением. Число не заменяет потерянную

    // находку, но делает потерю видимой — иначе «находок меньше» и

    // «находок нет» выглядят одинаково.

    if (invented > 0) {

      this.logger.warn(

        `ManipulationDetector для разговора ${conversationId}: модель сослалась на ${invented} несуществующих реплик — эти находки не сохранены`,

      );

    }


    return { points: created, notice: chunkedAnalysisNotice(chunks.length, estimateMinutes(totalChars)) };
  }

  /** Список уже найденных манипулятивных приёмов (без нового AI-вызова)
   * — восстанавливает technique/description из общего AIInference.output
   * по segmentId, тот же паттерн, что TurningPointsService.list(). */
  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segments = conversation.transcript?.segments ?? [];
    const segmentIds = segments.map((s: { id: string }) => s.id);
    // Сверка длинных разговоров 2026-09-04: подпись про разбор частями
    // считается и здесь — иначе она исчезала бы при обновлении экрана.
    const notice = chunkedAnalysisNotice(
      chunkSegments(segments, (s: any) => `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`).length,
      estimateMinutes(segments.reduce((n: number, s: any) => n + s.text.length, 0)),
    );
    if (segmentIds.length === 0) return { points: [], notice: null };

    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: ConversationSignalType.MANIPULATION_PATTERN,
        transcriptSegmentId: { in: segmentIds },
      },
      include: {
        transcriptSegment: true,
        evidence: { include: { aiInference: true } },
      },
    });

    const segmentOrder = new Map<string, number>(
      segmentIds.map((id: string, i: number): [string, number] => [id, i]),
    );
    const points = signals
      .map((signal: any) => {
        const resolved = this.resolveTechniqueAndDescription(signal);
        return { ...signal, technique: resolved?.technique ?? null, description: resolved?.description ?? null };
      })
      .sort(
        (a: any, b: any) =>
          (segmentOrder.get(a.transcriptSegmentId ?? '') ?? 0) -
          (segmentOrder.get(b.transcriptSegmentId ?? '') ?? 0),
      );
    return { points, notice };
  }

  private resolveTechniqueAndDescription(signal: {
    transcriptSegmentId: string | null;
    evidence: Array<{ aiInference: { output: string } | null }>;
  }): { technique: string; description: string } | null {
    for (const ev of signal.evidence) {
      if (!ev.aiInference) continue;
      try {
        const parsed: RawManipulationPoint[] = JSON.parse(ev.aiInference.output);
        const match = parsed.find((p) => p.segmentId === signal.transcriptSegmentId);
        if (match) return { technique: match.technique, description: match.description };
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
