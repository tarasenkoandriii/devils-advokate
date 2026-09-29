// Пункт 45: PrecedentSearchService (§3.9 ТЗ) — реализует ПОЛОВИНУ
// пункта 21 v3-роадмапа. Вторая половина (поиск по публичным
// источникам) СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАНА — подробное обоснование см.
// над моделью BehaviorPrecedent в schema.prisma: это ровно тот
// автономный поиск по конкретному частному человеку, от которого явно
// отказались раньше в этом заходе (диалог перед Пунктом 40). Позиция
// не пересмотрена — реализована только честная половина: прецеденты
// из личных записей пользователя (прошлые разговоры + факты), уже
// сохранённых в приложении.
//
// АГРЕГАЦИЯ ИСТОРИИ — переиспользует тот же паттерн, что уже построен
// в CommunicationProfileService (Пункт 39): все проанализированные
// разговоры, где этот человек участвовал (через participant.personId,
// через ВСЕ проекты пользователя, не только текущий) + PersonFact.
//
// РАЗМЕТКА ПО СХОЖЕСТИ (§3.9 ТЗ) — ANALOGOUS/PARTIALLY_SIMILAR/
// CONTRASTING, буквально из текста. "Итоговый вывод... вероятностная,
// а не голословная оценка" — вычисляется в list() из РЕАЛЬНОГО
// подсчёта уже накопленных прецедентов (не отдельное поле, не
// придумывается заново при каждом обращении).

import { personLevelFactsScopeWhere } from '../common/fact-scope';
import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, PrecedentSimilarity } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { factsBlockWithInstruction } from '../common/fact-provenance';
import { orderLabel } from '../common/server-time';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';
import { isEnumValue } from '../common/enum-values';

const TASK_TYPE = 'precedent-search';

interface RawPrecedent {
  precedentDescription: string;
  similarity: 'ANALOGOUS' | 'PARTIALLY_SIMILAR' | 'CONTRASTING';
  sourceDescription: string;
}

// Экспортируется ради проверки на ПОВЕДЕНИИ: сверка принимает КАЖДОЕ
// значение перечисления (Пункт [enum-copy-drifted] 2026-09-29).
export function isValidPrecedentPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.precedentDescription === 'string' &&
        item.precedentDescription.trim().length > 0 &&
        isEnumValue(PrecedentSimilarity, item.similarity) &&
        typeof item.sourceDescription === 'string' &&
        item.sourceDescription.trim().length > 0,
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Тебе даны прошлые разговоры и известные факты о человеке, а также описание НОВОЙ ситуации. Найди прецеденты — случаи из прошлого, где этот человек вёл себя в похожих или контрастных обстоятельствах. Для каждого найденного прецедента укажи: precedentDescription — конкретно, что он сделал/сказал в том случае, similarity — ANALOGOUS (аналогичный кейс, ситуация очень похожа), PARTIALLY_SIMILAR (частично похожий), или CONTRASTING (контрастный пример — в похожей на первый взгляд ситуации поступил иначе), sourceDescription — на основании какого конкретного разговора или факта сделан вывод. Если данных недостаточно ни для одного прецедента — верни пустой массив. НЕ выдумывай прецеденты, которых нет в данных. Ответь СТРОГО валидным JSON-массивом объектов вида {"precedentDescription": string, "similarity": "ANALOGOUS"|"PARTIALLY_SIMILAR"|"CONTRASTING", "sourceDescription": string}. Без пояснений вне JSON.';

@Injectable()
export class PrecedentSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly consent: ConsentService,
  ) {}

  async findPrecedents(userId: string, personId: string, situationDescription: string, engineId?: string) {
    // Пункт [consent-that-could-not-be-given] 2026-09-24: предмет этого
    // разбора — названный человек, и решение владельца (§16.0 ТЗ)
    // требует для таких разборов ОТДЕЛЬНОГО согласия. Граница и обе её
    // стороны — в common-реестре `consent/person-research.ts`.
    await this.consent.requireConsent(userId, ConsentType.PERSON_RESEARCH);
    await this.assertOwnedPerson(userId, personId);
    if (!situationDescription.trim()) {
      throw new BadRequestException('situationDescription не может быть пустым — нужно знать, для какой ситуации искать прецедент');
    }

    const [facts, conversations] = await Promise.all([
      // Пункт [scope-not-applied] 2026-09-06 — разбор уровня человека:
      // projectId сюда не приходит по самой задаче, поэтому правило
      // слабее проектного и исключает только «не публикуется никогда».
      this.prisma.personFact.findMany({ where: { personId, status: 'ACTIVE', ...personLevelFactsScopeWhere() } }),
      this.prisma.conversation.findMany({
        where: {
          status: { in: [ConversationProcessingStatus.TRANSCRIBED, ConversationProcessingStatus.ANALYZED] },
          participants: { some: { personId } },
        },
        include: { transcript: { include: { segments: { where: { participant: { personId } } } } } },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);

    if (facts.length === 0 && conversations.length === 0) {
      throw new BadRequestException(
        `Person ${personId} has no facts or analyzed conversations yet — nothing to search for precedents in`,
      );
    }

    const factsSummary = facts.length > 0 ? factsBlockWithInstruction(facts) : '(фактов нет)';
    const conversationsSummary = conversations
      // Пункт [server-said-which-day] 2026-09-24: стояло число по UTC.
      // День здесь был нужен для хронологии, а не сам по себе, — и
      // порядок сервер знает точно, в отличие от числа.
      .map((c: any, i: number, all: any[]) => {
        const text = (c.transcript?.segments ?? []).map((s: any) => s.text).join(' ');
        return text ? `(разговор ${orderLabel(i, all.length, true)}) ${text}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    const userPrompt = `Факты о человеке, каждый с указанием происхождения:\n${factsSummary}\n\nЕго реплики из прошлых разговоров:\n${conversationsSummary || '(реплик пока нет)'}\n\nНовая ситуация, для которой нужен прецедент: ${situationDescription}`;

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidPrecedentPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось найти прецеденты — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawPrecedents: RawPrecedent[] = JSON.parse(result.text);

    // Пункт [click-count] 2026-09-05: повторный поиск по той же ситуации
    // создавал строки заново. Один и тот же реальный случай мог попасть в
    // таблицу трижды — и трижды посчитаться в доле «X из Y раз вёл себя
    // схожим образом», и трижды занять место в окне последних пяти
    // прецедентов, которое уходит в разборы (пункт [partial-basis]).
    //
    // Сравнение по паре «ситуация + описание прецедента»: это ровно то,
    // что делает две записи одной и той же находкой. Тексты сравниваются
    // после trim и в нижнем регистре — модель на повторном запуске
    // возвращает ту же мысль с точностью до регистра и пробела, и
    // считать это разными случаями было бы самообманом.
    const existing = await this.prisma.behaviorPrecedent.findMany({
      where: { personId, situationDescription },
      select: { precedentDescription: true },
    });
    const seen = new Set(
      existing.map((e: { precedentDescription: string }) => e.precedentDescription.trim().toLowerCase()),
    );

    const fresh: RawPrecedent[] = [];
    let duplicatesSkipped = 0;
    for (const p of rawPrecedents) {
      const key = p.precedentDescription.trim().toLowerCase();
      if (seen.has(key)) {
        duplicatesSkipped++;
        continue;
      }
      seen.add(key);
      fresh.push(p);
    }

    const created = await this.prisma.$transaction(
      fresh.map((p) =>
        this.prisma.behaviorPrecedent.create({
          data: {
            personId,
            situationDescription,
            precedentDescription: p.precedentDescription,
            similarity: p.similarity as PrecedentSimilarity,
            sourceDescription: p.sourceDescription,
            generatedByInferenceId: result.aiInferenceId,
          },
        }),
      ),
    );

    // Отсечённое НАЗЫВАЕТСЯ. Молчаливое «ничего не добавилось» человек
    // читает как «продукт не сработал» и жмёт снова — тот же изъян, что
    // разобран в пунктах [silent-destruction] и [dropped-quotes].
    return { created, duplicatesSkipped };
  }

  /** "Итоговый вывод по фигуранту... вероятностная, а не голословная
   * оценка" (§3.9 ТЗ).
   *
   * ПУНКТ [click-count] 2026-09-05 — ЧТО ЗДЕСЬ БЫЛО. Строка звучала так:
   * «в похожих ситуациях 4 из 6 раз вёл себя схожим образом» — то есть
   * как вероятностное утверждение О ЧЕЛОВЕКЕ. За ней стояли два числа,
   * которых оно не выдерживает:
   *
   *  1. ЗНАМЕНАТЕЛЬ БЫЛ НЕ О ТОМ. `total` считал ВСЕ строки таблицы по
   *     этому человеку — накопленные РАЗНЫМИ поисками, по разным
   *     ситуациям. «Похожие ситуации» в тексте и «всё, что вообще нашли
   *     про человека» в числе — разные множества, а показывались как
   *     одно.
   *  2. ЧИСЛИТЕЛЬ РОС ОТ НАЖАТИЙ. Повторный поиск по той же ситуации
   *     создавал строки заново: ничто не мешало одному и тому же
   *     реальному случаю попасть в таблицу трижды. Доля менялась от
   *     кликов, а не от жизни человека. И тот же счётчик кормил разборы:
   *     в контекст идут ПОСЛЕДНИЕ пять прецедентов (пункт
   *     [partial-basis]) — три копии одного случая вытесняли из окна три
   *     настоящих.
   *
   * ЧТО СТАЛО. Доля считается ВНУТРИ одной ситуации — той, для которой
   * человек искал прецеденты, — и прямо названо, чтó это за доля: часть
   * найденного продуктом, а не часть жизни человека. Повторы при
   * сохранении отсекаются (см. `search`), и об отсечённых сказано, а не
   * умолчано. */
  async list(userId: string, personId: string) {
    await this.assertOwnedPerson(userId, personId);
    const precedents = await this.prisma.behaviorPrecedent.findMany({
      where: { personId },
      orderBy: { createdAt: 'desc' },
    });

    const total = precedents.length;
    const analogousCount = precedents.filter((p: { similarity: string }) => p.similarity === 'ANALOGOUS').length;

    // Ситуаций может быть несколько: человек искал прецеденты для разных
    // случаев. Доля осмысленна только внутри одной, поэтому считается по
    // самой свежей — той, которую он смотрит.
    const latestSituation = precedents[0]?.situationDescription ?? null;
    const forSituation = latestSituation
      ? precedents.filter((p: { situationDescription: string }) => p.situationDescription === latestSituation)
      : [];
    const analogousForSituation = forSituation.filter((p: { similarity: string }) => p.similarity === 'ANALOGOUS').length;

    const conclusion =
      total === 0
        ? 'Прецедентов пока не найдено.'
        : [
            `Для ситуации «${latestSituation}» найдено ${forSituation.length} прецедент(ов), из них аналогичных — ${analogousForSituation}.`,
            'Это доля среди НАЙДЕННОГО в сохранённых разговорах и фактах, а не доля случаев в жизни человека:',
            'продукт видит только то, что вы записали, и не знает, сколько раз бывало иначе.',
            total > forSituation.length
              ? `Всего по этому человеку накоплено ${total} прецедент(ов) — по разным ситуациям; складывать их в одну долю нельзя.`
              : '',
          ]
            .filter(Boolean)
            .join(' ');

    return {
      precedents,
      total,
      analogousCount,
      // Числа по текущей ситуации — отдельно от общих, чтобы экран не
      // складывал разное.
      situation: latestSituation,
      situationTotal: forSituation.length,
      situationAnalogousCount: analogousForSituation,
      conclusion,
    };
  }

  private async assertOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}
