// Пункт [prompt-framework]: CalibrationService
// (devils-advocate-prompt-framework-tz.md, §4.3) — принципиально
// другая механика, чем классификационный/структурный gate: не
// прогон на фиксированном датасете размеченных кейсов, а плановая
// пересборка статистики по реально накопленным исходам
// (OutcomeScenario.outcomeConfirmed, заполняется пользователем
// постфактум через OutcomeForecastingController.confirmOutcome —
// это поле и сам метод подтверждения не существовали в проекте
// вообще до этой ревизии, добавлены заново, см. schema.prisma).
//
// ФИКСИРОВАННЫЕ ЯКОРЯ ДЛЯ BRIER SCORE, НЕ ЦИРКУЛЯРНЫЙ РАСЧЁТ —
// сознательное решение при реализации, не было явно зафиксировано в
// ТЗ. Если бы Brier score считался против ТОЛЬКО ЧТО эмпирически
// выведенной calibratedProbability той же самой корзины — это было бы
// тавтологией (метрика измеряла бы себя саму, не реальную точность
// категорий LOW/MEDIUM/HIGH). Вместо этого Brier score считается
// против ФИКСИРОВАННЫХ якорей (0.25/0.5/0.75) — измеряет, насколько
// сами категории LOW/MEDIUM/HIGH соответствуют реальности, независимо
// от последующей калибровки. calibratedProbability — ОТДЕЛЬНОЕ,
// эмпирическое значение (доля подтверждённых исходов в корзине),
// записывается обратно в OutcomeScenario как лучшая текущая оценка,
// не участвует в собственном вычислении.

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioConfidence } from '@prisma/client';
import { bucketCalibration, MIN_BUCKET_SAMPLE_SIZE } from './bucket-calibration';

const MIN_SAMPLE_SIZE = 30; // ТЗ §4.3, буквально зафиксировано как стартовое значение
const CONFIDENCE_ANCHORS: Record<string, number> = { LOW: 0.25, MEDIUM: 0.5, HIGH: 0.75 };

@Injectable()
export class CalibrationService {
  constructor(private readonly prisma: PrismaService) {}

  // Вызывается плановым заданием (pg_cron, тот же паттерн, что уже
  // используется в проекте — не по HTTP-запросу, ТЗ §5.3: "без POST —
  // пересчёт полностью автоматический").
  /** Пункт [background-jobs] 2026-09-04 — счёт по корзинам ОДНИМ запросом
   * к БД вместо чтения всех подтверждённых сценариев в память.
   *
   * Было: `findMany` без потолка по всей таблице — все подтверждённые
   * исходы ВСЕХ пользователей продукта уезжали в память планового
   * задания ради четырёх средних. На старте это десятки строк, дальше
   * растёт линейно вместе с продуктом и никогда не уменьшается; тик,
   * который однажды не поместится в память, не сообщит об этом никому —
   * калибровка просто перестанет обновляться. Ровно тот же класс, что
   * разбирался в [page-limits], только у задачи без экрана.
   *
   * groupBy даёт ту же арифметику: доля подтверждённых в корзине и
   * Brier score считаются из счётчиков, а не из перечисления строк. */
  private async bucketCounts(): Promise<Map<string, { total: number; confirmed: number }>> {
    // groupBy у Prisma типизируется через возвращаемое значение, поэтому
    // приведение стоит на самом вызове, а не на результате — иначе TS
    // выводит тип аргумента из ожидаемого ответа и ругается на аргумент.
    const groupBy = this.prisma.outcomeScenario.groupBy as unknown as (args: unknown) => Promise<
      Array<{ confidence: string; outcomeConfirmed: boolean | null; _count: { _all: number } }>
    >;
    const grouped = await groupBy({
      by: ['confidence', 'outcomeConfirmed'],
      where: { outcomeConfirmed: { not: null } },
      _count: { _all: true },
    });

    const buckets = new Map<string, { total: number; confirmed: number }>();
    for (const g of grouped) {
      const entry = buckets.get(g.confidence) ?? { total: 0, confirmed: 0 };
      entry.total += g._count._all;
      if (g.outcomeConfirmed === true) entry.confirmed += g._count._all;
      buckets.set(g.confidence, entry);
    }
    return buckets;
  }

  async recomputeCalibration() {
    const buckets = await this.bucketCounts();
    let datasetSampleSize = 0;
    for (const counts of buckets.values()) datasetSampleSize += counts.total;

    // Эмпирическая точность по корзине — записывается обратно во ВСЕ
    // сценарии этой корзины (и уже подтверждённые, и ещё нет) как
    // лучшая текущая оценка вероятности для новых сценариев такой же
    // категории уверенности.
    //
    // Пункт [uncalibrated-number] 2026-09-06: но только если выборка
    // САМОЙ КОРЗИНЫ дошла до порога. Ниже порога пишется NULL — это
    // ровно то, что означает NULL по schema.prisma («ещё не
    // откалибровано»), и это снимает число, записанное прежней
    // версией пересчёта по одному-двум исходам. Обоснование порога и
    // почему он отдельный от gatePassed — в bucket-calibration.ts.
    for (const bucket of Object.keys(CONFIDENCE_ANCHORS) as ScenarioConfidence[]) {
      const calibration = bucketCalibration(buckets.get(bucket), datasetSampleSize, MIN_SAMPLE_SIZE);
      // Снятие числа адресуется только тем строкам, где число есть:
      // иначе плановое задание каждую ночь переписывало бы NULL'ом
      // всю таблицу сценариев продукта — ровно тот класс, что
      // разбирался в [background-jobs], только записью вместо чтения.
      // Запись самого числа адресуется всей корзине: там значение
      // меняется на новое, а не «остаётся как было».
      const where =
        calibration.calibratedProbability === null
          ? { confidence: bucket, calibratedProbability: { not: null } }
          : { confidence: bucket };
      await this.prisma.outcomeScenario.updateMany({
        where,
        data: { calibratedProbability: calibration.calibratedProbability },
      });
    }

    return this.getStatus();
  }

  /** ПОВТОРНЫЙ АУДИТ 2026-08-30 — обёртка с проверкой роли. getStatus()
   * оставлен без проверки намеренно: его же зовёт recomputeCalibration(),
   * который выполняется плановым заданием, а не пользователем, и роли у
   * него нет по определению. Разделение «внутренний вызов / вызов из
   * HTTP» — тот же приём, что у AuditLogService.record(). */
  async getStatusForOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
    return this.getStatus();
  }

  async getStatus() {
    // Пункт [background-jobs] 2026-09-04 — здесь была вторая копия того
    // же неограниченного чтения (getStatus зовётся и из планового
    // задания, и с операторского экрана). Brier score раскладывается на
    // счётчики без потери точности: внутри корзины якорь один и тот же,
    // поэтому сумма квадратов ошибок — это два слагаемых на корзину,
    // взвешенных числом подтверждённых и неподтверждённых исходов.
    const buckets = await this.bucketCounts();

    let sampleSize = 0;
    let sumSquaredError = 0;
    for (const [confidence, counts] of buckets) {
      const anchor = CONFIDENCE_ANCHORS[confidence] ?? 0.5;
      const notConfirmed = counts.total - counts.confirmed;
      sampleSize += counts.total;
      sumSquaredError += counts.confirmed * (anchor - 1) ** 2 + notConfirmed * anchor ** 2;
    }

    const gatePassed = sampleSize >= MIN_SAMPLE_SIZE;
    const brierScore = sampleSize > 0 ? sumSquaredError / sampleSize : null;

    // Пункт [uncalibrated-number] 2026-09-06 — разбивка по корзинам
    // рядом со сводным числом. Без неё экран показывал одну общую
    // выборку, и «30 подтверждённых исходов» читалось как «все три
    // корзины измерены», хотя тридцать могли лежать в одной. Корзины
    // перечислены ВСЕ, включая пустые: отсутствующая корзина обязана
    // попасть в ответ строкой — иначе повторится то же молчание, что
    // разбиралось в сверке плановых заданий.
    const bucketRows = (Object.keys(CONFIDENCE_ANCHORS) as ScenarioConfidence[]).map((confidence) => ({
      confidence,
      ...bucketCalibration(buckets.get(confidence), sampleSize, MIN_SAMPLE_SIZE),
    }));

    return {
      sampleSize,
      brierScore,
      threshold: MIN_SAMPLE_SIZE,
      gatePassed,
      bucketThreshold: MIN_BUCKET_SAMPLE_SIZE,
      buckets: bucketRows,
    };
  }
}
