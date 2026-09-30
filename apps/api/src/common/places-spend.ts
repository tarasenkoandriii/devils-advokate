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
import type { PrismaService } from '../prisma/prisma.service';

/** Действие в журнале, по которому считается суточный расход. Имя одно
 * на все шесть дверей — иначе потолок считал бы только свою. */
export const PLACES_USAGE_ACTION = 'places.request';

function tooMany(limit: number): HttpException {
  // 429, как у остальных потолков: предел временный, не правовой.
  return new HttpException(
    `Достигнут суточный лимит обращений к картам (${limit}/сутки). Попробуйте позже.`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

async function spentToday(prisma: PrismaService, userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.auditLogEntry.count({
    where: { actorId: userId, action: PLACES_USAGE_ACTION, createdAt: { gte: since } },
  });
}

/** Одно платное обращение к Places: проверка потолка И отметка расхода,
 * в этом порядке. Вызывается ПЕРЕД каждым запросом — по одному разу на
 * запрос, а не на операцию. */
export async function spendPlacesRequest(prisma: PrismaService, userId: string, what: string): Promise<void> {
  const limit = spendLimit('PLACES_REQUESTS_PER_USER_PER_DAY');
  if (limit === 0) return; // явное «не ограничивай» — как у остальных потолков
  if ((await spentToday(prisma, userId)) >= limit) throw tooMany(limit);
  await prisma.auditLogEntry.create({
    data: { actorId: userId, action: PLACES_USAGE_ACTION, resource: 'GooglePlaces', resourceId: what },
  });
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
