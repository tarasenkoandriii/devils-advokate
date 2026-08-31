// Пункт [telemetry]: TelemetryService (devils-advocate-telemetry-tz.md)
// — операционная видимость по уже накопленным данным AIJob, не учёт
// стоимости (§1 ТЗ: отдельная задача, сознательно вынесена за пределы
// этой ревизии — см. TODO.md).
//
// Агрегация — живой запрос при каждом обращении (findMany за период +
// вычисление в JS), НЕ предвычисленная rollup-таблица (§4.1 ТЗ,
// буквально: "не строить инфраструктуру под нагрузку, которой пока
// нет"). Вычисление в JS, а не raw SQL GROUP BY/percentile_cont — тот
// же выбор тестируемости, что уже сделан в CalibrationService: сервис
// проверяется той же fake-Prisma-моделью моков (findMany), без
// зависимости от реальной Postgres в этой среде разработки, где сети
// к живой базе нет вообще.

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const NULL_GROUP_KEY = '__NULL_TASK_TYPE__';

type StatusKey = 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED';
const STATUS_KEYS: StatusKey[] = ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'];

export interface TelemetrySummaryRow {
  taskType: string | null;
  totalCalls: number;
  byStatus: Record<StatusKey, number>;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  retryRate: number;
  schemaValidationFailRate: number;
  inputBlockedCount: number;
}

export interface AIJobDetail {
  id: string;
  status: string;
  modelVersion: string;
  promptVersionId: string | null;
  retryCount: number;
  durationMs: number | null;
  schemaValidation: string;
  inputScanStatus: string;
  createdAt: string;
}

interface JobRow {
  id: string;
  status: string;
  retryCount: number;
  schemaValidation: string;
  inputScanStatus: string;
  taskType: string | null;
  createdAt: Date;
  completedAt: Date | null;
  modelVersionId: string;
  promptVersionId: string | null;
}

@Injectable()
export class TelemetryService {
  constructor(private readonly prisma: PrismaService) {}

  // Тот же минимальный подход, что уже применяется в PromptRegistryService/
  // EvaluationService/CalibrationService — не self-service, не RBAC.
  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }

  private buildDateFilter(from?: string, to?: string) {
    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    return where;
  }

  private aggregate(jobs: JobRow[]): Omit<TelemetrySummaryRow, 'taskType'> {
    const totalCalls = jobs.length;

    const byStatus: Record<StatusKey, number> = { COMPLETED: 0, FAILED: 0, TIMEOUT: 0, CANCELLED: 0 };
    for (const job of jobs) {
      if ((STATUS_KEYS as string[]).includes(job.status)) {
        byStatus[job.status as StatusKey]++;
      }
    }

    // Длительность — только среди job, у которых completedAt реально
    // заполнен (ТЗ §5, четвёртый acceptance-тест: если ни один вызов
    // ещё не завершился — null, не 0, "0 подразумевал бы вызовы
    // мгновенными, это неправда").
    const durations = jobs
      .filter((j) => j.completedAt !== null)
      .map((j) => j.completedAt!.getTime() - j.createdAt.getTime());

    const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const p95DurationMs = durations.length > 0 ? this.percentile(durations, 0.95) : null;

    const retryRate = totalCalls > 0 ? jobs.filter((j) => j.retryCount > 0).length / totalCalls : 0;
    const schemaValidationFailRate =
      totalCalls > 0 ? jobs.filter((j) => j.schemaValidation === 'FAIL').length / totalCalls : 0;
    const inputBlockedCount = jobs.filter((j) => j.inputScanStatus === 'BLOCKED').length;

    return { totalCalls, byStatus, avgDurationMs, p95DurationMs, retryRate, schemaValidationFailRate, inputBlockedCount };
  }

  private percentile(sortedInputValues: number[], p: number): number {
    const sorted = [...sortedInputValues].sort((a, b) => a - b);
    // Ближайший ранг — простая, честная реализация без внешней
    // зависимости; для соло-масштаба проекта (§4.1 ТЗ) этого достаточно,
    // не претендует на точность промышленного observability-стека.
    const rank = Math.ceil(p * sorted.length) - 1;
    const idx = Math.min(Math.max(rank, 0), sorted.length - 1);
    return sorted[idx];
  }

  /** §4.1: сводка по каждому taskType за период. */
  async getSummary(userId: string, from?: string, to?: string): Promise<TelemetrySummaryRow[]> {
    await this.assertOperator(userId);

    const jobs: JobRow[] = await this.prisma.aIJob.findMany({ where: this.buildDateFilter(from, to) });

    const groups = new Map<string, JobRow[]>();
    for (const job of jobs) {
      const key = job.taskType ?? NULL_GROUP_KEY;
      const bucket = groups.get(key);
      if (bucket) bucket.push(job);
      else groups.set(key, [job]);
    }

    const rows: TelemetrySummaryRow[] = [];
    for (const [key, bucketJobs] of groups) {
      rows.push({ taskType: key === NULL_GROUP_KEY ? null : key, ...this.aggregate(bucketJobs) });
    }
    return rows;
  }

  /** §4.3: тот же агрегат, группировка по modelVersionId вместо taskType. */
  async getByModel(userId: string, from?: string, to?: string): Promise<Array<Omit<TelemetrySummaryRow, 'taskType'> & { modelVersion: string }>> {
    await this.assertOperator(userId);

    const jobs: JobRow[] = await this.prisma.aIJob.findMany({ where: this.buildDateFilter(from, to) });
    const modelVersionIds = [...new Set(jobs.map((j) => j.modelVersionId))];
    const versions = await this.prisma.aIModelVersion.findMany({ where: { id: { in: modelVersionIds } } });
    const versionById = new Map<string, string>(versions.map((v: any) => [v.id as string, v.version as string]));

    const groups = new Map<string, JobRow[]>();
    for (const job of jobs) {
      const bucket = groups.get(job.modelVersionId);
      if (bucket) bucket.push(job);
      else groups.set(job.modelVersionId, [job]);
    }

    const rows: Array<Omit<TelemetrySummaryRow, 'taskType'> & { modelVersion: string }> = [];
    for (const [modelVersionId, bucketJobs] of groups) {
      rows.push({ modelVersion: versionById.get(modelVersionId) ?? modelVersionId, ...this.aggregate(bucketJobs) });
    }
    return rows;
  }

  /** §4.2: последние N вызовов конкретной фичи, с деталями провалов. */
  async getTaskDetail(userId: string, taskType: string, limit = 50, status?: string): Promise<AIJobDetail[]> {
    await this.assertOperator(userId);

    const where: any = { taskType };
    if (status) where.status = status;

    const jobs: JobRow[] = await this.prisma.aIJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const modelVersionIds = [...new Set(jobs.map((j) => j.modelVersionId))];
    const versions = await this.prisma.aIModelVersion.findMany({ where: { id: { in: modelVersionIds } } });
    const versionById = new Map<string, string>(versions.map((v: any) => [v.id as string, v.version as string]));

    return jobs.map((j) => ({
      id: j.id,
      status: j.status,
      modelVersion: versionById.get(j.modelVersionId) ?? j.modelVersionId,
      promptVersionId: j.promptVersionId,
      retryCount: j.retryCount,
      durationMs: j.completedAt ? j.completedAt.getTime() - j.createdAt.getTime() : null,
      schemaValidation: j.schemaValidation,
      inputScanStatus: j.inputScanStatus,
      createdAt: j.createdAt.toISOString(),
    }));
  }
}
