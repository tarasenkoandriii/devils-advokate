// Пункт 52: DecisionOutcomeService (§3.2 ТЗ) — калибровка решений во
// времени (Decision Track Record), пункт 35 v3-роадмапа. По прямому
// запросу, первый пункт из списка неначатых после аудита.
//
// ЧЕСТНОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ (подробно — см. schema.prisma над
// DecisionOutcome): "показывает когнитивные искажения" (буквально из
// ТЗ) реализовано как РЕАЛЬНАЯ ВЫЧИСЛЕННАЯ СТАТИСТИКА (прогноз vs
// факт, по категориям), НЕ AI-догадка о психологии пользователя. Ни
// одного AI-вызова в этом сервисе вообще — вся статистика
// детерминированная, посчитана из реально накопленных данных.
// Пользователь сам делает вывод о своих паттернах, система только
// показывает факты, не ставит диагноз.
//
// "ПЕРЕОЦЕНИВАЕТ РИСКИ" РАЗЛОЖЕНО НА ДВЕ РАЗНЫЕ НАПРАВЛЕННОСТИ, не
// один общий "процент промаха" — overOptimisticCount (аргументы
// склоняли к действию, исход оказался плохим — риск недооценён) и
// overCautiousCount (аргументы склоняли против, исход оказался
// хорошим — риск переоценён) считаются раздельно, чтобы показать
// направление расхождения, не просто "вы часто ошибаетесь".

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, DecisionOutcomeRating, EscalationCategory } from '@prisma/client';

// Порядок значимости категорий накала — используется только здесь,
// для сравнения "пик vs последнее состояние" при подсчёте сглаженных
// конфликтов. Тот же порядок, что подразумевается самой ТЗ
// (CALM→RISING→HIGH→CRITICAL), не отдельная классификация.
const ESCALATION_RANK: Record<EscalationCategory, number> = {
  CALM: 0,
  RISING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// Ниже этого порога категория не показывается в разбивке — один или
// два случая недостаточно, чтобы говорить о паттерне, не единичной
// случайности. Порог произвольный, но разумный, явно
// задокументированный, не скрытый магическим числом без объяснения.
const MIN_CATEGORY_SAMPLE_SIZE = 3;

export interface CategoryCalibrationStats {
  category: string | null;
  sampleSize: number;
  matchCount: number;
  overOptimisticCount: number; // прогноз склонялся "за", исход оказался плохим
  overCautiousCount: number; // прогноз склонялся "против", исход оказался хорошим
  matchRate: number; // 0..1, доля среди классифицируемых случаев (MIXED/TOO_EARLY_TO_TELL не входят)
}

// Пункт 73 (§3.34 ТЗ) — "Статистика успешности разговоров", пункт 53
// общего списка v4-роадмапа. По прямому запросу.
//
// Пункт 85 ДОБАВИЛ ВТОРУЮ МЕТРИКУ, ранее честно отсутствовавшую —
// "количество прекращённых/сглаженных конфликтов" (buкально ТЗ:
// "сессии, где эскалация пошла вниз после пика, а не разговор
// оборвался на пике"). Была заблокирована отсутствием самого следа
// категории накала во времени на backend (индикатор Пункта 83 —
// чисто клиентский). По прямому запросу решено ПОСТРОИТЬ настоящий
// след (EscalationCategoryEvent), не приближать через уже существующие
// CooldownNudgeEvent (те фиксируют только отдельные всплески, не
// непрерывную траекторию категорий).
//
// СКОЛЬЗЯЩИЕ ОКНА, НЕ КАЛЕНДАРНЫЕ — "не привязаны к календарной
// неделе" (buкально ТЗ). Прочитано как относящееся ко ВСЕМ трём
// периодам, не только к неделе: "сегодня" здесь — последние 24 часа
// от текущего момента, не "с полуночи". Явное архитектурное решение,
// не скрытая интерпретация.
export interface SuccessStats {
  positiveOutcomesToday: number;
  positiveOutcomesLast3Days: number;
  positiveOutcomesLastWeek: number;
  conflictsSmoothedToday: number;
  conflictsSmoothedLast3Days: number;
  conflictsSmoothedLastWeek: number;
}

@Injectable()
export class DecisionOutcomeService {
  constructor(private readonly prisma: PrismaService) {}

  /** predictedLean фиксируется В МОМЕНТ записи исхода — не
   * пересчитывается позже, даже если аргументы в проекте изменятся
   * (см. обоснование в schema.prisma). Только project-level PRO/CON
   * (targetPersonId=null) — тот же фильтр, что уже применялся в
   * OutcomeForecastingService (Пункт 47). */
  async recordOutcome(
    userId: string,
    projectId: string,
    input: { actualOutcome: DecisionOutcomeRating; outcomeNotes?: string; category?: string },
  ) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const args = await this.prisma.argument.findMany({
      where: { projectId, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
    });
    const weighted = args.filter((a: { weight: number | null }) => a.weight !== null);
    const predictedLean =
      weighted.length === 0
        ? null
        : weighted.reduce((sum: number, a: { stance: string; weight: number | null }) => {
            const w = a.weight as number;
            return sum + (a.stance === 'PRO' ? w : -w);
          }, 0);

    return this.prisma.decisionOutcome.upsert({
      where: { projectId },
      create: {
        projectId,
        predictedLean,
        actualOutcome: input.actualOutcome,
        outcomeNotes: input.outcomeNotes ?? null,
        category: input.category ?? null,
      },
      update: {
        predictedLean,
        actualOutcome: input.actualOutcome,
        outcomeNotes: input.outcomeNotes ?? null,
        category: input.category ?? null,
      },
    });
  }

  async getOutcome(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.decisionOutcome.findUnique({ where: { projectId } });
  }

  /** Ни одного AI-вызова — чистая статистика по уже накопленным
   * DecisionOutcome записям пользователя (через все его проекты,
   * не один конкретный). "Общий" срез + разбивка по категориям (только
   * категории с MIN_CATEGORY_SAMPLE_SIZE и более случаями — иначе
   * шум выглядел бы как паттерн). */
  async getCalibrationSummary(userId: string) {
    const outcomes = await this.prisma.decisionOutcome.findMany({
      where: { project: { ownerId: userId } },
    });

    const overall = this.computeStats(outcomes, null);
    const categoryGroups = new Map<string, typeof outcomes>();
    for (const o of outcomes) {
      if (!o.category) continue;
      const list = categoryGroups.get(o.category) ?? [];
      list.push(o);
      categoryGroups.set(o.category, list);
    }
    const byCategory: CategoryCalibrationStats[] = [...categoryGroups.entries()]
      .filter(([, list]) => list.length >= MIN_CATEGORY_SAMPLE_SIZE)
      .map(([category, list]) => this.computeStats(list, category));

    return { totalRecorded: outcomes.length, overall, byCategory };
  }

  /** "Скользящие окна, не привязаны к календарной неделе" (buкально
   * ТЗ) — все три периода считаются от текущего момента назад, не от
   * начала календарного дня/недели. Честно суженный объём — см.
   * обоснование над интерфейсом SuccessStats выше: только метрика
   * "решено положительно", вторая метрика ТЗ заблокирована §3.33. */
  async getSuccessStats(userId: string): Promise<SuccessStats> {
    const now = Date.now();
    const startToday = new Date(now - 24 * 60 * 60 * 1000);
    const start3Days = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const startWeek = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const outcomes = await this.prisma.decisionOutcome.findMany({
      where: { project: { ownerId: userId }, actualOutcome: DecisionOutcomeRating.WENT_WELL },
      select: { recordedAt: true },
    });

    // "Эскалация пошла вниз после пика, а не разговор оборвался на
    // пике" (buкально ТЗ) — читаем ВСЕ события за неделю разом (самое
    // широкое окно), группируем по сессии, остальные окна — фильтр
    // по времени ПОСЛЕДНЕГО события сессии, не пересчитываем заново.
    const escalationEvents = await this.prisma.escalationCategoryEvent.findMany({
      where: { project: { ownerId: userId }, createdAt: { gte: startWeek } },
      orderBy: { createdAt: 'asc' },
      select: { sessionId: true, category: true, createdAt: true },
    });

    const sessionEvents = new Map<string, { category: EscalationCategory; createdAt: Date }[]>();
    for (const e of escalationEvents) {
      const list = sessionEvents.get(e.sessionId) ?? [];
      list.push({ category: e.category, createdAt: e.createdAt });
      sessionEvents.set(e.sessionId, list);
    }

    const smoothedLastEventAt: Date[] = [];
    for (const events of sessionEvents.values()) {
      // events уже отсортированы по времени (весь запрос был orderBy asc).
      const ranks = events.map((e) => ESCALATION_RANK[e.category]);
      const maxRank = Math.max(...ranks);
      const lastRank = ranks[ranks.length - 1];
      // "Пошла вниз после пика" — реальный пик (не CALM) И финал ниже пика.
      if (maxRank > ESCALATION_RANK.CALM && lastRank < maxRank) {
        smoothedLastEventAt.push(events[events.length - 1].createdAt);
      }
    }

    return {
      positiveOutcomesToday: outcomes.filter((o: { recordedAt: Date }) => o.recordedAt >= startToday).length,
      positiveOutcomesLast3Days: outcomes.filter((o: { recordedAt: Date }) => o.recordedAt >= start3Days).length,
      positiveOutcomesLastWeek: outcomes.filter((o: { recordedAt: Date }) => o.recordedAt >= startWeek).length,
      conflictsSmoothedToday: smoothedLastEventAt.filter((d) => d >= startToday).length,
      conflictsSmoothedLast3Days: smoothedLastEventAt.filter((d) => d >= start3Days).length,
      conflictsSmoothedLastWeek: smoothedLastEventAt.length,
    };
  }

  /** "sessionId генерируется клиентом при старте AssistanceScreen,
   * события — только переходы между категориями, не каждый замер" —
   * см. обоснование в schema.prisma над EscalationCategoryEvent. */
  async logEscalationCategory(userId: string, projectId: string, sessionId: string, category: EscalationCategory) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.escalationCategoryEvent.create({ data: { projectId, sessionId, category } });
  }

  private computeStats(outcomes: any[], category: string | null): CategoryCalibrationStats {
    let matchCount = 0;
    let overOptimisticCount = 0;
    let overCautiousCount = 0;

    for (const o of outcomes) {
      if (o.predictedLean === null || o.predictedLean === 0) continue; // нечего сравнивать
      if (o.actualOutcome === DecisionOutcomeRating.MIXED || o.actualOutcome === DecisionOutcomeRating.TOO_EARLY_TO_TELL) continue;

      const predictedProceed = o.predictedLean > 0;
      const wentWell = o.actualOutcome === DecisionOutcomeRating.WENT_WELL;

      if (predictedProceed === wentWell) {
        matchCount++;
      } else if (predictedProceed && !wentWell) {
        overOptimisticCount++; // склонялись действовать, исход плохой — риск недооценён
      } else {
        overCautiousCount++; // склонялись не действовать, исход хороший — риск переоценён
      }
    }

    const classifiable = matchCount + overOptimisticCount + overCautiousCount;
    return {
      category,
      sampleSize: outcomes.length,
      matchCount,
      overOptimisticCount,
      overCautiousCount,
      matchRate: classifiable === 0 ? 0 : matchCount / classifiable,
    };
  }
}
