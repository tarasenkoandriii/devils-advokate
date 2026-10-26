// Пункт [the-priciest-door-had-no-lock] 2026-09-30 — шесть маршрутов к
// платному Google Places без единого ограничения.
//
// НАЙДЕНО. Places API тарифицируется ЗА КАЖДЫЙ ЗАПРОС, и из всех
// неограниченных путей продукта этот был самым дорогим на единицу
// обращения. Ни потолка, ни кэша, ни записи расхода, ни строки в
// реестре расходов:
//
//   venue-recommendation.generate            → Nearby Search + Place Details ПО КАЖДОМУ кандидату
//   GET  /venue-applications/search          → Text Search
//   GET  /venue-applications/autofill/:id    → Place Details
//   major-purchase.setLocationByGeolocation  → Nearby (по расстоянию) + Place Details
//   major-purchase.searchLocationByText      → Text Search
//   major-purchase.setLocationByPlaceId      → Place Details
//
// Любой аутентифицированный человек в цикле жёг биллинг-аккаунт
// владельца. Единственной проверкой было согласие `LOCATION` — то есть
// проверялось ПРАВО, а не количество.
//
// ЧТО СЧИТАЕМ. Именно ЗАПРОСЫ, а не операции: одна генерация
// рекомендаций делает до четырёх обращений (Nearby + Details на трёх
// кандидатов), и считать её за единицу значило бы недосчитать
// вчетверо. Отметка пишется ПЕРЕД обращением — неудачный запрос тоже
// оплачен провайдером, и недосчитать здесь дороже, чем пересчитать.
// Правило в проекте было (`youtube-search.service.ts`), просто не
// везде.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Кэша нет: он снял бы повторы того же
// запроса, но у поиска по тексту и по координатам повторов мало, а
// хранение ответа Places (с отзывами) — отдельное решение о хранении
// чужих данных, которое шапка `google-places-client.ts` намеренно
// оставляет незакрытым («сервер хранит ссылку, не скачивает»). Потолок
// решает задачу расходов, кэш решал бы другую.

import { HttpException, HttpStatus } from '@nestjs/common';
import { spendLimit } from './spend-limits';
import { withSpendLock } from './outward-spend';
import type { PrismaService } from '../prisma/prisma.service';
import { dailyLimitRefusal, dailyWindowStart, releaseAt } from './daily-limit';

/** Действие в журнале, по которому считается суточный расход. Имя одно
 * на все шесть дверей — иначе потолок считал бы только свою. */
export const PLACES_USAGE_ACTION = 'places.request';

/** Пункт [the-day-was-the-servers] 2026-10-26: отказ называет, через
 *  сколько освободится место. Самая старая отметка окна читается ТОЛЬКО
 *  здесь, то есть только когда отказ уже неизбежен. */
function tooMany(limit: number, oldestInWindow: Date | null): HttpException {
  // 429, как у остальных потолков: предел временный, не правовой.
  return new HttpException(
    dailyLimitRefusal({ subject: 'обращения к картам', limit, oldestInWindow }),
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

const windowWhere = (userId: string) => ({
  actorId: userId,
  action: PLACES_USAGE_ACTION,
  createdAt: { gte: dailyWindowStart() },
});

async function spentToday(prisma: PrismaService, userId: string): Promise<number> {
  return prisma.auditLogEntry.count({ where: windowWhere(userId) });
}

/** Порядок с `id` вторым ключом — Пункт [the-first-row-was-whichever]:
 *  `createdAt` не уникален. */
async function oldestInWindow(prisma: PrismaService, userId: string): Promise<Date | null> {
  const row = await prisma.auditLogEntry.findFirst({
    where: windowWhere(userId),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/** Одно платное обращение к Places: проверка потолка И отметка расхода,
 * в этом порядке. Вызывается ПЕРЕД каждым запросом — по одному разу на
 * запрос, а не на операцию. */
export async function spendPlacesRequest(prisma: PrismaService, userId: string, what: string): Promise<void> {
  const limit = spendLimit('PLACES_REQUESTS_PER_USER_PER_DAY');
  if (limit === 0) return; // явное «не ограничивай» — как у остальных потолков
  // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: счёт и
  // отметка — одно событие под замком. См. шапку `withSpendLock`: без
  // него двадцать одновременных попыток при потолке пять давали
  // двадцать записей, то есть потолок не держал ничего.
  await withSpendLock(prisma, userId, PLACES_USAGE_ACTION, async (tx) => {
    if ((await spentToday(tx, userId)) >= limit) throw tooMany(limit, await oldestInWindow(tx, userId));
    await tx.auditLogEntry.create({
      data: { actorId: userId, action: PLACES_USAGE_ACTION, resource: 'GooglePlaces', resourceId: what },
    });
  });
}

/** Когда освободится ПЕРВОЕ обращение окна. Нужно там, где отказ
 * объясняет, сколько ждать: сам потолок об этом не знает, а человек
 * спрашивает именно это. */
export async function placesFirstRelease(prisma: PrismaService, userId: string): Promise<Date | null> {
  return releaseAt(await oldestInWindow(prisma, userId));
}

/** Сколько обращений ещё можно сделать. Нужно там, где операция делает
 * их несколько в цикле: упереться в потолок на середине и бросить 429
 * значило бы потерять уже сделанную работу, поэтому цикл ОСТАНАВЛИВАЕТСЯ
 * и говорит об этом вслух. */
export async function placesRequestsLeft(prisma: PrismaService, userId: string): Promise<number> {
  const limit = spendLimit('PLACES_REQUESTS_PER_USER_PER_DAY');
  if (limit === 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, limit - (await spentToday(prisma, userId)));
}
