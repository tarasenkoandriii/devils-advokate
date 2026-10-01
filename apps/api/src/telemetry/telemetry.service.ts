// Пункт [telemetry]: TelemetryService (devils-advocate-telemetry-tz.md)
// — операционная видимость по уже накопленным данным AIJob, не учёт
// стоимости (§1 ТЗ: отдельная задача, сознательно вынесена за пределы
// этой ревизии — см. TODO.md).
//
// Агрегация — живой запрос при каждом обращении (findMany за период +
// вычисление в JS), НЕ предвычисленная rollup-таблица (§4.1 ТЗ,
// буквально: "не строить инфраструктуру под нагрузку, которой пока
// нет").
//
// ПОПРАВКА, Пункт [the-example-stopped-being-an-example] 2026-09-30.
// Здесь стояло: «Вычисление в JS, а не raw SQL GROUP BY/percentile_cont
// — тот же выбор тестируемости, что уже сделан в CalibrationService».
// К этому дню обоснование ссылалось на образец, КОТОРЫЙ САМ ПЕРЕСТАЛ
// так делать: сверка фоновых чтений исправила `CalibrationService`
// ровно за это («было: findMany без потолка по всей таблице — все
// подтверждённые исходы всех пользователей в память ради четырёх
// средних»), и он считает в базе через `groupBy`. То есть пример,
// приведённый в оправдание, к моменту чтения доказывал обратное.
// Сама причина (тестируемость на фейке без живой Postgres) остаётся
// верной, и вычисление остаётся в JS; неверной была ссылка.
//
// ВТОРАЯ ПОЛОВИНА, и она про поведение, а не про текст. Чтение шло БЕЗ
// ПОТОЛКА, а `from`/`to` необязательны — значит по умолчанию экран
// читал ВСЮ таблицу `AIJob`, которая растёт на строку с каждым
// AI-вызовом каждого пользователя и не чистится никогда. Числа при
// этом честные (итог по всему), но читается для них всё, и в пределе
// это не «медленно», а 504 от платформы: агрегат считается внутри
// функции с потолком 60 с.
//
// Поэтому: выборка ограничена и УПОРЯДОЧЕНА ПО СВЕЖЕСТИ, а ответ
// НАЗЫВАЕТ, по скольким вызовам он посчитан. Это не «потолок,
// спрятанный внутри итога» (Пункт [ceiling-hid-inside-a-total]): там
// итог по срезу выдавали за итог по всему, здесь срез назван вслух и
// печатается оператору.

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { subsetOf } from '../common/enum-values';
import { AIJobStatus } from '@prisma/client';

const NULL_GROUP_KEY = '__NULL_TASK_TYPE__';

/** Сколько последних задач берётся в сводку.
 *
 *  Не `DEFAULT_PAGE_LIMIT` (200): двести AI-вызовов — это часы работы
 *  одного человека, и перцентиль по такой выборке говорит о вчерашнем
 *  дне, а не о системе. Пять тысяч — запас на порядок больше, при
 *  котором агрегат остаётся осмысленным, а чтение — ограниченным. */
export const TELEMETRY_MAX_JOBS = 5_000;

/** По скольким задачам посчитан агрегат. Отдаётся ВМЕСТЕ с числами: без
 *  этого оператор не может отличить «столько и было» от «показаны
 *  последние». */
export interface TelemetryCoverage {
  /** Сколько задач попало в расчёт. */
  jobsCounted: number;
  /** Потолок выборки. */
  limit: number;
  /** Есть ли за пределами выборки ещё задачи. */
  truncated: boolean;
}

/** Конечные состояния задачи — те, по которым считается сводка. Пункт
 * [enum-copy-drifted] 2026-09-29: QUEUED и RUNNING сюда не входят
 * намеренно, это состояния «ещё идёт», и складывать их с исходами
 * значило бы считать незавершённое завершённым. */
const STATUS_KEYS = subsetOf(
  AIJobStatus,
  [AIJobStatus.COMPLETED, AIJobStatus.FAILED, AIJobStatus.TIMEOUT, AIJobStatus.CANCELLED],
  'сводка считает ИСХОДЫ задач; QUEUED и RUNNING исходами не являются — задача ещё идёт',
);
type StatusKey = (typeof STATUS_KEYS)[number];

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

  /** Последние задачи за период, с зондом на «есть ещё».
   *
   *  Зонд обязан быть съеден — правило `common/page.ts` («кто взял зонд,
   *  тот обязан его съесть»): здесь он превращается в `truncated`, а в
   *  расчёт уходит ровно потолок строк. */
  private async recentJobs(from?: string, to?: string): Promise<{ jobs: JobRow[]; coverage: TelemetryCoverage }> {
    const rows: JobRow[] = await this.prisma.aIJob.findMany({
      where: this.buildDateFilter(from, to),
      // Сверка [tie-is-random] поймала первую версию этой правки: у
      // среза с потолком обязан быть ОПРЕДЕЛЁННЫЙ порядок, иначе
      // «последние 5000» при совпавших метках времени — произвольные
      // 5000. Задачи создаются пачками и попадают в одну миллисекунду
      // легко, поэтому вторым ключом идёт уникальный столбец.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TELEMETRY_MAX_JOBS + 1,
    });
    const truncated = rows.length > TELEMETRY_MAX_JOBS;
    const jobs = truncated ? rows.slice(0, TELEMETRY_MAX_JOBS) : rows;
    return { jobs, coverage: { jobsCounted: jobs.length, limit: TELEMETRY_MAX_JOBS, truncated } };
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
  async getSummary(userId: string, from?: string, to?: string): Promise<{ rows: TelemetrySummaryRow[]; coverage: TelemetryCoverage }> {
    await this.assertOperator(userId);

    const { jobs, coverage } = await this.recentJobs(from, to);

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
    return { rows, coverage };
  }

  /** §4.3: тот же агрегат, группировка по modelVersionId вместо taskType. */
  async getByModel(
    userId: string,
    from?: string,
    to?: string,
  ): Promise<{ rows: Array<Omit<TelemetrySummaryRow, 'taskType'> & { modelVersion: string }>; coverage: TelemetryCoverage }> {
    await this.assertOperator(userId);

    const { jobs, coverage } = await this.recentJobs(from, to);
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
    return { rows, coverage };
  }

  /** §4.2: последние N вызовов конкретной фичи, с деталями провалов. */
  async getTaskDetail(userId: string, taskType: string, limit = 50, status?: string): Promise<AIJobDetail[]> {
    await this.assertOperator(userId);

    const where: any = { taskType };
    if (status) where.status = status;

    const jobs: JobRow[] = await this.prisma.aIJob.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
