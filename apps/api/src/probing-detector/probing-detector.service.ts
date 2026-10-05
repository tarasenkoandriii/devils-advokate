// Пункт 86: ProbingDetectorService (§3.37 ТЗ, "детектор прощупывания")
// — пункт 55 общего списка v4-роадмапа. По прямому запросу, после
// явного разбора объёма перед реализацией.
//
// ЦИКЛ ДО 30 СЕКУНД, ГОЛЫЙ ТЕКСТОВЫЙ ОКОННЫЙ ФРАГМЕНТ — тот же
// архитектурный паттерн, что уже трижды доказан (LiveHintsService,
// LiveManipulationService, LiveArgumentTrackingService). НЕ хранит
// транскрипт между вызовами.
//
// ПЕРСИСТЕНТНОЕ ОТСЛЕЖИВАНИЕ ТЕМЫ МЕЖДУ ЦИКЛАМИ — AI получает список
// уже отслеживаемых тем (id + описание) вместе с новым фрагментом,
// решает для каждого обнаруженного упоминания: совпадает ли оно по
// смыслу с уже отслеживаемой темой (matchedTopicId) или это новая
// тема (создаётся с repeatCount=1). Сопоставление по СМЫСЛУ, не
// точному тексту — иначе "бюджет на переезд" и "сколько у вас денег
// на переезд" считались бы разными темами.
//
// ПРЕДУПРЕЖДЕНИЕ ТОЛЬКО ПРИ repeatCount >= 2 — первое упоминание
// темы честно НЕ считается прощупыванием само по себе (buкально ТЗ
// "дважды, трижды"), только заводит запись для отслеживания. analyze()
// возвращает ТОЛЬКО темы, реально достигшие порога в этом вызове.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MAX_LIVE_WINDOW_CHARS, assertWithinLimit } from '../ai-router/prompt-limits';
import { ProbingTopic } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hasPersonVerdict, NO_PERSON_VERDICT_RULE } from '../common/no-person-verdict';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { activePromptVersion } from '../common/active-prompt-version';

const TASK_TYPE = 'probing-detection';
const REPEAT_THRESHOLD = 2; // "дважды, трижды" — buкально ТЗ, первое упоминание не считается
const MAX_CONFIDENCE = 0.9; // жёсткий потолок — "никогда не выдаётся как стопроцентное чтение мыслей", buкально ТЗ

interface RawProbingSignal {
  matchedTopicId?: string; // id из уже отслеживаемых, если совпадает по смыслу
  topicDescription: string; // конкретная формулировка темы — обязательна всегда, даже при совпадении (для читаемости результата)
}

/** Пункт [the-second-line-stood-elsewhere] 2026-09-30 — вторая линия
 * защиты стояла не у тех разборов, предмет которых — человек.
 *
 * `hasPersonVerdict` применялся в ТРЁХ местах: детектор манипуляций,
 * живой детектор манипуляций, паралингвистика. Все три разбирают ПРИЁМ
 * В РЕПЛИКЕ. А у разборов, чей предмет — САМ НАЗВАННЫЙ ЧЕЛОВЕК
 * (портрет общения, прецеденты его поведения, гипотезы о его мотивах),
 * стоял ТОЛЬКО промпт. Собственный реестр продукта
 * (`consent/person-research.ts`, `PERSON_RESEARCH_GATED`) называет эти
 * три сайта поимённо — то есть проект знал, где предмет опаснее всего,
 * и вторую линию там не поставил.
 *
 * Шапка `no-person-verdict.ts` сама говорит, зачем вторая линия: «он
 * ГРУБЫЙ… Первая линия — промпт; это вторая, на случай, когда первая
 * не сработала». И её же шапка говорит, что сравнивались ДВА разбора —
 * на этом сверка и остановилась. */
function isValidProbingPayload(text: string): boolean {
  if (hasPersonVerdict(text)) return false;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.topicDescription === 'string' &&
        item.topicDescription.trim().length > 0 &&
        (item.matchedTopicId === undefined || typeof item.matchedTopicId === 'string'),
    );
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дан ПОСЛЕДНИЙ фрагмент транскрипта живого разговора и список уже отслеживаемых тем, которые ранее были распознаны как потенциальное "прощупывание" — целенаправленный, настойчивый интерес собеседника к конкретной теме (наводящие вопросы с разных сторон, повтор темы в разных формулировках, резкий возврат к теме после смены разговора). НЕ считай обычные уточняющие вопросы прощупыванием — только настойчивые, повторяющиеся или явно наводящие. Для каждого случая настойчивого интереса к теме в этом фрагменте верни объект: если тема по СМЫСЛУ совпадает с одной из уже отслеживаемых (даже если сформулирована другими словами) — укажи matchedTopicId именно этой темы; если это новая, ранее не отслеживаемая тема — оставь matchedTopicId пустым. topicDescription — ВСЕГДА конкретная формулировка темы ("бюджет на переезд", не "финансовый вопрос"). Ответь СТРОГО валидным JSON-массивом объектов вида {"matchedTopicId": string (опционально), "topicDescription": string}. Если настойчивого интереса к какой-либо теме в этом фрагменте нет — верни пустой массив [].' +
  ' ' +
  NO_PERSON_VERDICT_RULE;

@Injectable()
export class ProbingDetectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async analyze(userId: string, projectId: string, transcriptWindow: string, engineId?: string, personId?: string | null) {
    if (!transcriptWindow.trim()) {
      throw new BadRequestException('transcriptWindow не может быть пустым');
    }
    // Аудит границ ввода 2026-09-03: окно живого цикла — последние минуты
    // разговора, а не архив. Клиент вызывает цикл сам, каждые 15–45 секунд,
    // и содержимое окна задаёт тоже он.
    assertWithinLimit(transcriptWindow, MAX_LIVE_WINDOW_CHARS, 'Окно транскрипта');
    await assertProjectOwnership(this.prisma, userId, projectId);
    // Пункт [project-log-v2] — собеседник, если пользователь его выбрал:
    // без него тема отслеживается и предупреждает как прежде, но в лог
    // проекта (§3.39) не попадает, потому что назвать в записи некого.
    if (personId) {
      const link = await this.prisma.projectPerson.findFirst({ where: { projectId, personId } });
      if (!link) throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    const trackedTopics = await this.prisma.probingTopic.findMany({ where: { projectId } });
    const topicsText = trackedTopics
      .map((t: { id: string; topicDescription: string; repeatCount: number }) => `[${t.id}] "${t.topicDescription}" (уже упомянута ${t.repeatCount} раз)`)
      .join('\n');

    const userPrompt = [
      `Фрагмент транскрипта:\n${transcriptWindow}`,
      topicsText ? `Уже отслеживаемые темы:\n${topicsText}` : 'Отслеживаемых тем пока нет.',
    ].join('\n\n');

    const activePrompt = await activePromptVersion(this.prisma, TASK_TYPE);

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
        maxTokens: 500,
        validateOutput: isValidProbingPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось проверить фрагмент — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawSignals: RawProbingSignal[] = JSON.parse(result.text);
    const trackedById = new Map(trackedTopics.map((t: { id: string }) => [t.id, t]));

    const crossedThreshold: ProbingTopic[] = [];
    for (const signal of rawSignals) {
      let record;
      if (signal.matchedTopicId && trackedById.has(signal.matchedTopicId)) {
        const existing = trackedById.get(signal.matchedTopicId) as { id: string; repeatCount: number };
        const newRepeatCount = existing.repeatCount + 1;
        record = await this.prisma.probingTopic.update({
          where: { id: existing.id },
          data: {
            repeatCount: newRepeatCount,
            confidence: this.computeConfidence(newRepeatCount),
            lastDetectedAt: new Date(),
            // Тему, начатую без выбранного собеседника, можно доименовать
            // позже — но уже названного человека новый вызов не подменяет:
            // это была бы тихая переатрибуция чужих слов.
            ...(personId && !(existing as { personId?: string | null }).personId ? { personId } : {}),
          },
        });
      } else {
        // AI указал matchedTopicId, которого нет в отслеживаемых — честно
        // трактуем как новую тему, не отбрасываем сигнал целиком.
        record = await this.prisma.probingTopic.create({
          data: {
            projectId,
            topicDescription: signal.topicDescription,
            repeatCount: 1,
            confidence: this.computeConfidence(1),
            personId: personId ?? null,
          },
        });
      }

      // "Предупреждение только при repeatCount >= 2" — возвращаем
      // только темы, реально достигшие порога, не все подряд.
      if (record.repeatCount >= REPEAT_THRESHOLD) {
        crossedThreshold.push(record);
      }
    }

    return crossedThreshold;
  }

  /** "Растёт с числом повторов, никогда не 1.0" — buкально ТЗ.
   * Формула честно приближённая, не откалиброванная на реальных
   * данных — тот же класс предварительного значения, что thresholdDb
   * в acoustic-monitor.ts (Пункт 81). */
  private computeConfidence(repeatCount: number): number {
    return Math.min(MAX_CONFIDENCE, 0.3 + (repeatCount - 1) * 0.2);
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.probingTopic.findMany({ where: { projectId }, orderBy: { lastDetectedAt: 'desc' } });
  }
}
