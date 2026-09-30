// Пункт [five-copies-of-one-counter] 2026-09-30 — один счётчик вместо
// пяти почти одинаковых.
//
// К этому дню у продукта было три модуля счёта расходов, написанных
// подряд и по одному образцу: `stt/transcription-spend.ts`,
// `common/places-spend.ts` и зашитые счётчики внутри
// `youtube-search.service.ts`, `health.service.ts`,
// `photo-verification.service.ts`. Все делают одно и то же: считают
// записи в журнале за сутки, сравнивают с потолком из реестра, бросают
// 429, отмечают расход ДО платного шага.
//
// Четыре новых потолка (живая расшифровка, геокодирование, погода,
// фактчек) — это был выбор между четырьмя новыми копиями и одним
// общим местом. Проект уже знает, чем кончаются копии: «правило было,
// просто не везде» — самая частая находка его собственных сверок, и
// ровно она породила `transcription-spend.ts` двумя Пунктами раньше.
//
// ЧТО ЗДЕСЬ ЕСТЬ. Счёт по журналу аудита, проверка потолка из реестра
// по ключу, отметка расхода. Порядок намеренный: проверка, потом
// отметка, потом платный вызов — неудачная попытка тоже считается,
// потому что провайдер мог быть уже задет, а недосчитать дороже, чем
// пересчитать.
//
// ЧЕГО ЗДЕСЬ НЕТ. Второй размерности (минуты, байты): у транскрибации
// потолок двойной, и её модуль остаётся со своим телом — он считает
// ещё и длительность из `after`. Сведение их в одну функцию с
// необязательным вторым измерением сделало бы общий путь сложнее ради
// одного случая.

import { HttpException, HttpStatus } from '@nestjs/common';
import { spendLimitByKey } from './spend-limits';
import type { PrismaService } from '../prisma/prisma.service';

export interface OutwardSpend {
  /** Ключ записи в реестре расходов. */
  readonly limitKey: string;
  /** Действие в журнале. ОДНО на все двери одного расхода — разные
   *  имена означали бы, что каждая дверь считает только себя. */
  readonly action: string;
  /** Что оператор увидит в записи журнала как ресурс. */
  readonly resource: string;
  /** Как назвать предел человеку, который в него упёрся. */
  readonly refusalSubject: string;
}

/** Сколько уже потрачено за сутки. */
export async function spentToday(prisma: PrismaService, userId: string, action: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.auditLogEntry.count({
    where: { actorId: userId, action, createdAt: { gte: since } },
  });
}

/** Сколько ещё можно. `Number.MAX_SAFE_INTEGER` — когда потолок снят
 *  нулём: это «не ограничивай», а не «нулевой потолок». */
export async function outwardCallsLeft(prisma: PrismaService, userId: string, spend: OutwardSpend): Promise<number> {
  const limit = spendLimitByKey(spend.limitKey);
  if (limit === 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, limit - (await spentToday(prisma, userId, spend.action)));
}

/** Одно платное обращение наружу: проверка потолка И отметка расхода,
 *  в этом порядке. Вызывается ПЕРЕД обращением — по разу на обращение,
 *  а не на операцию: операция, делающая два запроса, тратит два. */
export async function spendOutwardCall(
  prisma: PrismaService,
  userId: string,
  spend: OutwardSpend,
  what: string,
): Promise<void> {
  const limit = spendLimitByKey(spend.limitKey);
  if (limit === 0) return; // явное «не ограничивай»
  if ((await spentToday(prisma, userId, spend.action)) >= limit) {
    // 429, как у остальных потолков: предел временный, не правовой.
    throw new HttpException(
      `Достигнут суточный лимит: ${spend.refusalSubject} (${limit}/сутки). Попробуйте позже.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  await prisma.auditLogEntry.create({
    data: { actorId: userId, action: spend.action, resource: spend.resource, resourceId: what },
  });
}

/** Проверка БЕЗ отметки — для шага, который сам ничего не тратит, но
 *  и не имеет смысла при выбранном потолке (приём байтов, которые
 *  сегодня всё равно не расшифровать). */
export async function assertOutwardCallsLeft(
  prisma: PrismaService,
  userId: string,
  spend: OutwardSpend,
): Promise<void> {
  if ((await outwardCallsLeft(prisma, userId, spend)) > 0) return;
  throw new HttpException(
    `Достигнут суточный лимит: ${spend.refusalSubject} (${spendLimitByKey(spend.limitKey)}/сутки). Попробуйте позже.`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

// ── Реестр расходов наружу, у которых счёт идёт по журналу ──
//
// Имена действий — в одном месте: разъехавшиеся имена означали бы, что
// два вызова одного расхода считаются порознь, и потолок вдвое выше
// заявленного.

export const REALTIME_TOKEN_SPEND: OutwardSpend = {
  limitKey: 'realtime-tokens',
  action: 'stt.realtime_token',
  resource: 'SttRealtimeToken',
  refusalSubject: 'ключи живой расшифровки',
};

export const GEOCODING_SPEND: OutwardSpend = {
  limitKey: 'geocoding-requests',
  action: 'geocoding.request',
  resource: 'Nominatim',
  refusalSubject: 'подсказки города по геолокации',
};

export const WEATHER_SPEND: OutwardSpend = {
  limitKey: 'weather-forecasts',
  action: 'weather.forecast',
  resource: 'WeatherForecast',
  refusalSubject: 'прогнозы погоды',
};

export const FACT_CHECK_SPEND: OutwardSpend = {
  limitKey: 'fact-checks',
  action: 'fact_check.request',
  resource: 'FactCheck',
  refusalSubject: 'проверки утверждений по внешней базе фактчека',
};

export const OUTWARD_SPENDS: readonly OutwardSpend[] = [
  REALTIME_TOKEN_SPEND,
  GEOCODING_SPEND,
  WEATHER_SPEND,
  FACT_CHECK_SPEND,
];
