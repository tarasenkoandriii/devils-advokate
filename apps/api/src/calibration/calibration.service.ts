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

const MIN_SAMPLE_SIZE = 30; // ТЗ §4.3, буквально зафиксировано как стартовое значение
const CONFIDENCE_ANCHORS: Record<string, number> = { LOW: 0.25, MEDIUM: 0.5, HIGH: 0.75 };

@Injectable()
export class CalibrationService {
  constructor(private readonly prisma: PrismaService) {}

  // Вызывается плановым заданием (pg_cron, тот же паттерн, что уже
  // используется в проекте — не по HTTP-запросу, ТЗ §5.3: "без POST —
  // пересчёт полностью автоматический").
  async recomputeCalibration() {
    const confirmed = await this.prisma.outcomeScenario.findMany({
      where: { outcomeConfirmed: { not: null } },
      select: { confidence: true, outcomeConfirmed: true },
    });

    // Эмпирическая точность по корзине — записывается обратно во ВСЕ
    // сценарии этой корзины (и уже подтверждённые, и ещё нет) как
    // лучшая текущая оценка вероятности для новых сценариев такой же
    // категории уверенности.
    for (const bucket of Object.keys(CONFIDENCE_ANCHORS) as ScenarioConfidence[]) {
      const inBucket = confirmed.filter((s: any) => s.confidence === bucket);
      if (inBucket.length === 0) continue;
      const empiricalAccuracy = inBucket.filter((s: any) => s.outcomeConfirmed === true).length / inBucket.length;
      await this.prisma.outcomeScenario.updateMany({
        where: { confidence: bucket },
        data: { calibratedProbability: empiricalAccuracy },
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
    const confirmed = await this.prisma.outcomeScenario.findMany({
      where: { outcomeConfirmed: { not: null } },
      select: { confidence: true, outcomeConfirmed: true },
    });

    const sampleSize = confirmed.length;
    const gatePassed = sampleSize >= MIN_SAMPLE_SIZE;

    let brierScore: number | null = null;
    if (sampleSize > 0) {
      const sumSquaredError = confirmed.reduce((sum: number, s: any) => {
        const anchor = CONFIDENCE_ANCHORS[s.confidence] ?? 0.5;
        const actual = s.outcomeConfirmed ? 1 : 0;
        return sum + (anchor - actual) ** 2;
      }, 0);
      brierScore = sumSquaredError / sampleSize;
    }

    return { sampleSize, brierScore, threshold: MIN_SAMPLE_SIZE, gatePassed };
  }
}
