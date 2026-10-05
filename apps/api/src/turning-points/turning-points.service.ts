// Пункт 15: TurningPointsService (§3.50 ТЗ) — вторая из 11 фич MVP v2
// поверх Conversation Dossier.
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ — НОВАЯ Prisma-модель НЕ заводилась вообще.
// У поворотных точек уже было всё нужное с чекпоинта 1:
// ConversationSignal(signalType=EMOTIONAL_SHIFT|ARGUMENT_ACCEPTANCE) —
// именно то, что описывает §3.50 ("накал необратимо пошёл вверх/вниз"
// = EMOTIONAL_SHIFT; "позиция фигуранта явно сдвинулась" =
// ARGUMENT_ACCEPTANCE, включая уже существующее правило §3.33 про
// confirmedGenuinely=false при совпадении с манипуляцией) —
// TranscriptSegment.startMs (Пункт 12/13) уже даёт точный таймкод
// ("не абстрактно где-то в середине, а конкретная минута/реплика") —
// TranscriptSegment.text уже даёт "какая фраза оказалась переломной".
//
// Единственное, чего не было — текстового объяснения ПОЧЕМУ AI считает
// момент переломным. Не добавлено как новое поле ConversationSignal
// (было бы полем, нужным только одному сигналу из шести существующих
// типов) — вместо этого переиспользован уже существующий путь
// AIInference + ConversationSignalEvidence, тот же паттерн, что уже
// в ArgumentGenerationService: ОДИН вызов AIRouterService → ОДИН
// AIInference → НЕСКОЛЬКО сущностей на него ссылаются (там —
// Argument.derivedFromInferenceId у всех аргументов одного вызова
// генерации, здесь — ConversationSignalEvidence.aiInferenceId у всех
// найденных за один прогон точек). detect()/list() парсят
// AIInference.output обратно в JSON и сопоставляют описание каждой
// точке по segmentId — не хранят N отдельных AIInference ради одного
// HTTP-вызова.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chunkSegments, chunkedAnalysisNotice, estimateMinutes } from '../common/transcript-chunks';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSignal, ConversationSignalType } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { allFilled } from '../common/claim-substance';
import { subsetOf } from '../common/enum-values';
import { activePromptVersion } from '../common/active-prompt-version';

const TASK_TYPE = 'turning-point-detection';

interface RawTurningPoint {
  segmentId: string;
  signalType: 'EMOTIONAL_SHIFT' | 'ARGUMENT_ACCEPTANCE';
  description: string;
  confidence?: number;
}

export function isValidTurningPointsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.segmentId === 'string' &&
        (TURNING_POINT_SIGNALS as readonly string[]).includes(item.signalType) &&
        // Пункт [finding-without-substance] 2026-09-25: signalType называет
        // вид перелома, описание — что именно произошло. Без описания на
        // экране остаётся ярлык.
        allFilled(item, ['description']) &&
        (item.confidence === undefined || typeof item.confidence === 'number'),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты анализируешь транскрипт разговора построчно, с указанием говорящего и id реплики. Найди моменты, где направление разговора решающе изменилось: (1) EMOTIONAL_SHIFT — момент, после которого напряжённость разговора необратимо выросла или снизилась; (2) ARGUMENT_ACCEPTANCE — момент, где собеседник явно сдвинул позицию или согласился с чем-то. Для каждого найденного момента укажи id ИМЕННО ТОЙ реплики (segmentId), после которой произошёл перелом. Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "signalType": "EMOTIONAL_SHIFT"|"ARGUMENT_ACCEPTANCE", "description": string, "confidence": number от 0 до 1}. Если переломных моментов нет — верни пустой массив []. Без пояснений вне JSON.';

/** Виды сигнала, которые находит разбор переломов. Пункт
 * [enum-copy-drifted] 2026-09-29: остальные пять видов заводят другие
 * разборы (манипуляции, прощупывание, риск для себя, расхождение фактов,
 * расхождение слов с подачей) — это сужение, а не отставшая копия. */
const TURNING_POINT_SIGNALS = subsetOf(
  ConversationSignalType,
  [ConversationSignalType.EMOTIONAL_SHIFT, ConversationSignalType.ARGUMENT_ACCEPTANCE],
  'перелом в разговоре — это смена тона или принятие довода; остальные виды сигнала находят другие разборы и заводят сами',
);

@Injectable()
export class TurningPointsService {
  private readonly logger = new Logger(TurningPointsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** Запускает детекцию (AI-вызов) и сразу возвращает результат —
   * отдельного "запустить" и "посмотреть позже" нет, в отличие от
   * транскрибации: анализ уже готового транскрипта синхронный и
   * быстрый (один текстовый промпт, не долгая внешняя обработка
   * аудио), не требует async job+webhook флоу, как STT. */
  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (conversation.status !== ConversationProcessingStatus.TRANSCRIBED) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before turning-point detection (current: ${conversation.status})`,
      );
    }
    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new BadRequestException(`Разбор невозможен: у этого разговора нет расшифровки. Это не значит, что находок нет — их не искали.`);
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationProcessingStatus.ANALYZING },
    });

    const activePrompt = await activePromptVersion(this.prisma, TASK_TYPE);
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    const renderLine = (s: (typeof segments)[number]) =>
      `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`;
    // Сверка длинных разговоров 2026-09-04: полтора часа записи уже не
    // помещались в один запрос, и разбор отказывал совсем — на главном
    // случае продукта. Теперь длинный разговор разбирается частями, и
    // человеку об этом сказано (см. transcript-chunks.ts: что именно
    // теряется при разбивке).
    const chunks = chunkSegments(segments, renderLine);
    const totalChars = segments.reduce((n: number, s: (typeof segments)[number]) => n + s.text.length, 0);
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
    const rawPoints: Array<RawTurningPoint & { inferenceId: string }> = [];
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
          validateOutput: isValidTurningPointsPayload,
        });
        for (const point of JSON.parse(result.text) as RawTurningPoint[]) {
          rawPoints.push({ ...point, inferenceId: result.aiInferenceId });
        }
      }
    } catch (err) {
      // Статус откатывается на TRANSCRIBED (не остаётся в ANALYZING
      // навсегда) — тот же принцип, что AIRouterService откатывает
      // AIJob в FAILED при исключении, не оставляет RUNNING.
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationProcessingStatus.TRANSCRIBED },
      });
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException(
          'Анализ отклонён проверкой безопасности содержимого транскрипта.',
        );
      }
      throw new BadGatewayException(
        'Не удалось проанализировать разговор — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const segmentById = new Map<string, (typeof segments)[number]>(
      segments.map((s: (typeof segments)[number]): [string, (typeof segments)[number]] => [s.id, s]),
    );

    // §3.33 ТЗ (правило, на которое прямо ссылается §3.50): согласие,
    // совпадающее по времени с манипулятивным паттерном на том же
    // сегменте, не подтверждается как искреннее. Проверяется здесь
    // (service-слой), не в схеме — та же формулировка инварианта, что
    // уже была зафиксирована в комментарии схемы над полем
    // confirmedGenuinely с чекпоинта 1, применяется на практике впервые.
    const manipulationSegmentIds = new Set(
      (
        await this.prisma.conversationSignal.findMany({
          where: {
            signalType: ConversationSignalType.MANIPULATION_PATTERN,
            transcriptSegmentId: { in: [...segmentById.keys()] },
          },
          select: { transcriptSegmentId: true },
        })
      ).map((s: { transcriptSegmentId: string | null }) => s.transcriptSegmentId),
    );

    // Сверка молчаливых пропусков 2026-09-04: выдуманный моделью id

    // реплики означает потерянную находку, и раньше она исчезала

    // молча. `ParalinguisticsService` такие случаи СЧИТАЕТ и пишет

    // предупреждение — приём в проекте был, просто не везде. Число в

    // логе не заменяет находку, но делает потерю видимой тому, кто

    // разбирается, почему находок меньше ожидаемого.

    let invented = 0;

    const created: Array<ConversationSignal & { segment: (typeof segments)[number]; description: string }> = [];
    try {
      for (const point of rawPoints) {
        const segment = segmentById.get(point.segmentId);
        if (!segment) {
          invented++;
          continue;
        } // AI сослался на несуществующий id реплики — пропускаем, не падаем на всём батче

        // Сверка «половины операции» 2026-09-04: находка и её основание
        // записывались двумя отдельными вызовами. Сбой между ними оставлял
        // в базе сигнал БЕЗ единственной ссылки на то, откуда он взялся, —
        // то есть утверждение о человеке, происхождение которого продукт
        // назвать уже не может. Транзакция на пару, а не на весь батч:
        // инвариант «нет находки без основания» — про одну находку, а
        // остальные валидные терять незачем (тот же принцип, что строкой
        // выше про несуществующий id).
        const signal = await this.prisma.$transaction(async (tx) => {
          const s = await tx.conversationSignal.create({
            data: {
              signalType: point.signalType as ConversationSignalType,
              transcriptSegmentId: segment.id,
              participantId: segment.participantId,
              confidence: point.confidence ?? null,
              confirmedGenuinely:
                point.signalType === 'ARGUMENT_ACCEPTANCE' ? !manipulationSegmentIds.has(segment.id) : null,
            },
          });
          await tx.conversationSignalEvidence.create({
            data: { conversationSignalId: s.id, aiInferenceId: point.inferenceId },
          });
          return s;
        });
        created.push({ ...signal, segment, description: point.description });
      }
    } catch (err) {
      // Сверка «половины операции» 2026-09-04: откат статуса стоял только
      // вокруг AI-вызова. Сбой ЗАПИСИ оставлял разговор в ANALYZING
      // навсегда: detect() требует TRANSCRIBED, повторить анализ было
      // нельзя, а человек видел вечное «анализируется» вместо ошибки.
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationProcessingStatus.TRANSCRIBED },
      });
      throw err;
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationProcessingStatus.ANALYZED },
    });

    // Тот же приём, что уже стоит у `ParalinguisticsService`: пропуск с

    // подсчётом и одним предупреждением. Число не заменяет потерянную

    // находку, но делает потерю видимой — иначе «находок меньше» и

    // «находок нет» выглядят одинаково.

    if (invented > 0) {

      this.logger.warn(

        `TurningPoints для разговора ${conversationId}: модель сослалась на ${invented} несуществующих реплик — эти находки не сохранены`,

      );

    }


    return { points: created, notice: chunkedAnalysisNotice(chunks.length, estimateMinutes(totalChars)) };
  }

  /** Список уже найденных поворотных точек (без нового AI-вызова) —
   * восстанавливает description из общего AIInference.output по
   * segmentId, не хранит его отдельно на каждом ConversationSignal
   * (см. обоснование в шапке файла). */
  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segments = conversation.transcript?.segments ?? [];
    const segmentIds = segments.map((s: { id: string }) => s.id);
    // Сверка длинных разговоров 2026-09-04: подпись про разбор частями
    // считается и здесь, а не только сразу после детекции. Иначе она
    // исчезала бы при первом же обновлении экрана — то есть человек видел
    // бы полный на вид разбор длинного разговора без единого упоминания,
    // что связь начала с концом такой разбор не ищет.
    const notice = chunkedAnalysisNotice(
      chunkSegments(segments, (s: any) => `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`).length,
      estimateMinutes(segments.reduce((n: number, s: any) => n + s.text.length, 0)),
    );
    if (segmentIds.length === 0) return { points: [], notice: null };

    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: { in: [ConversationSignalType.EMOTIONAL_SHIFT, ConversationSignalType.ARGUMENT_ACCEPTANCE] },
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
        const description = this.resolveDescription(signal);
        return { ...signal, description };
      })
      .sort(
        (a: any, b: any) =>
          (segmentOrder.get(a.transcriptSegmentId ?? '') ?? 0) -
          (segmentOrder.get(b.transcriptSegmentId ?? '') ?? 0),
      );
    return { points, notice };
  }

  private resolveDescription(signal: {
    transcriptSegmentId: string | null;
    evidence: Array<{ aiInference: { output: string } | null }>;
  }): string | null {
    for (const ev of signal.evidence) {
      if (!ev.aiInference) continue;
      try {
        const parsed: RawTurningPoint[] = JSON.parse(ev.aiInference.output);
        const match = parsed.find((p) => p.segmentId === signal.transcriptSegmentId);
        if (match) return match.description;
      } catch {
        // AIInference.output от другой фичи/не JSON — пропускаем, не падаем
        continue;
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
