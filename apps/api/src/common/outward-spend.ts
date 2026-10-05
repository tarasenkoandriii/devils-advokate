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

/** Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05 — отметка
 *  расхода под замком, иначе потолок не держит НИЧЕГО.
 *
 *  НАЙДЕННОЕ, и это измерено на живом Postgres 16, а не выведено.
 *  Все суточные потолки расходов делали «посчитать, сравнить, вставить»
 *  тремя отдельными обращениями. Двадцать одновременных попыток при
 *  потолке пять дают:
 *
 *    посчитать-потом-вставить → 20 записей
 *    под этим замком          → 5 записей
 *
 *  То есть потолок не «немного превышался» — он не срабатывал вовсе, и
 *  перерасход равнялся числу одновременных запросов. Это единственный
 *  рычаг владельца на реальные деньги (Places, SerpApi, ElevenLabs,
 *  поминутная расшифровка), и он держался только тем, что запросы редко
 *  приходили одновременно.
 *
 *  ЧЕМ СДЕЛАНО. `pg_advisory_xact_lock` по паре (пользователь,
 *  действие) внутри одной транзакции: проверка и отметка перестают быть
 *  двумя событиями. Замок снимается концом транзакции, а она коммитится
 *  ДО снятия — значит следующий ожидающий видит уже вставленную строку.
 *
 *  ПОЧЕМУ НЕ `INSERT … SELECT … WHERE count < предел` одним запросом.
 *  Такой запрос короче, но под READ COMMITTED он тоже не держит:
 *  подзапрос со счётом ничего не блокирует, и два параллельных вызова
 *  оба увидят «предел-1». Проверено тем же прогоном — он держит ровно
 *  потому, что стои́т под тем же замком, а не сам по себе.
 *
 *  ПОЧЕМУ НЕ ТАБЛИЦА-СЧЁТЧИК с уникальным ключом на (пользователь,
 *  действие, сутки). Она чище и не требует замка, но требует МИГРАЦИИ —
 *  а ручные миграции здесь применяет владелец своими руками, и это
 *  отдельное решение, а не правка на ходу. Замок не меняет схему вовсе.
 *
 *  ЧЕГО ЭТО НЕ ДЕЛАЕТ:
 *   • замок — внутри одной базы. Два инстанса продукта на РАЗНЫХ базах
 *     считались бы порознь и раньше, это свойство счёта по журналу, а
 *     не этой правки;
 *   • при очереди длиннее таймаута транзакции вызов упадёт. Таймаут
 *     задан явно и назван ниже: лучше внятный отказ, чем молчаливый
 *     перерасход;
 *   • потолки, считающие НЕ по журналу (публичные потолки обсуждений,
 *     опыт в библиотеке), этой правкой не затронуты — у них своя
 *     таблица и свой заход.
 */
const SPEND_LOCK_TIMEOUT_MS = 10_000;

/** Проверка потолка и отметка расхода — одним событием.
 *
 *  Внутри `body` счёт и запись идут по той же транзакции `tx`, то есть
 *  под тем же замком. Передавать наружу `prisma` вместо `tx` нельзя: это
 *  вернуло бы ровно ту гонку, ради которой замок и ставится, — поэтому
 *  сверка пункта проверяет, что ни один счётчик не обращается внутри к
 *  чему-то, кроме `tx`. */
export async function withSpendLock<T>(
  prisma: PrismaService,
  userId: string,
  action: string,
  body: (tx: PrismaService) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // Ключ — пара «кто» и «за что»: разные расходы одного человека
      // друг друга не ждут, один расход одного человека — ждёт.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}|${action}`}, 0))`;
      return body(tx as unknown as PrismaService);
    },
    { timeout: SPEND_LOCK_TIMEOUT_MS },
  );
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
  // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: счёт и
  // отметка — под замком и по ОДНОЙ транзакции. Снаружи этого блока
  // проверка потолка значения не имеет: см. шапку withSpendLock.
  await withSpendLock(prisma, userId, spend.action, async (tx) => {
    if ((await spentToday(tx, userId, spend.action)) >= limit) {
      // 429, как у остальных потолков: предел временный, не правовой.
      throw new HttpException(
        `Достигнут суточный лимит: ${spend.refusalSubject} (${limit}/сутки). Попробуйте позже.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await tx.auditLogEntry.create({
      data: { actorId: userId, action: spend.action, resource: spend.resource, resourceId: what },
    });
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
