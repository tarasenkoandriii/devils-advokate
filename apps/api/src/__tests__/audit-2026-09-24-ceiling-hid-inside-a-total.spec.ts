// Пункт [ceiling-hid-inside-a-total] 2026-09-24 — поведенческая половина.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [budget-invented-a-currency] нашёл
// правило, записанное вместе с помощником и тестами и применённое в
// одном месте из четырёх. Здесь — тот же разрыв в механизме честного
// потолка, и обе его половины оказались хуже, чем «не применили».
//
// 1. ЗОНД БЕЗ ЕДОКА. `takeWithProbe()` берёт на строку БОЛЬШЕ потолка,
//    чтобы узнать «есть ещё», и эта строка обязана быть съедена
//    `pagedList`. В выгрузке персональных данных зонд вызывался, а
//    `pagedList` — нет: человек получал 201 решение о своём аккаунте, и
//    о потолке не говорилось нигде. В файле, чей ВЕСЬ смысл — полнота, и
//    который отдельным разделом называет каждое исключение по имени.
//
// 2. ПОТОЛОК ВНУТРИ ИТОГА. Операторский обзор очередей медиа отдавал 200
//    строк молча, а экран не показывал их по одной — он их СКЛАДЫВАЛ:
//    «очередей», «роликов», «доля разобранных». Итог по срезу под
//    подписью итога по всему. Обрезанный список хотя бы выглядит
//    списком; число выглядит фактом о системе.
//
// ПРАВИЛО: кто взял зонд, тот обязан его съесть — и итог обязан считать
// база по всем строкам, а не читающий по показанному срезу.

import { DEFAULT_PAGE_LIMIT } from '../common/page';
import { AdminDomainsService } from '../admin-domains/admin-domains.service';

const OVER = DEFAULT_PAGE_LIMIT + 40;

function queuesPrisma(count: number) {
  const queues = Array.from({ length: count }, (_, i) => ({
    id: `q${i}`,
    title: `очередь ${i}`,
    createdAt: new Date(2026, 0, 1 + (i % 28)),
    user: { telegramId: `${i}` },
    items: [{ status: 'DONE', createdAt: new Date(2026, 0, 1), conversation: null }],
  }));
  return {
    user: { findUnique: async () => ({ id: 'op', isOperator: true, role: 'OPERATOR' }) },
    mediaReviewQueue: {
      findMany: async ({ take }: any) => queues.slice(0, take),
      count: async () => queues.length,
    },
    mediaReviewQueueItem: {
      groupBy: async () => [{ status: 'DONE', _count: { _all: queues.length } }],
      findMany: async () => [],
    },
  } as any;
}

describe('[ceiling-hid-inside-a-total] потолок не читается как итог', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: итог по очередям считается по всей базе, а не по показанному срезу', async () => {
    const service = new AdminDomainsService(queuesPrisma(OVER), {} as any);

    const res = await service.mediaReviewQueues('op');

    // Показано ровно потолок, ни строкой больше — зонд съеден.
    expect(res.queues).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(res.hasMore).toBe(true);
    expect(res.limit).toBe(DEFAULT_PAGE_LIMIT);
    // А итог — по всем, иначе оператор прочитает потолок как факт.
    expect(res.totals.queues).toBe(OVER);
    expect(res.totals.items).toBe(OVER);
  });

  it('когда очередей меньше потолка, о потолке не говорится', async () => {
    const service = new AdminDomainsService(queuesPrisma(3), {} as any);

    const res = await service.mediaReviewQueues('op');

    expect(res.queues).toHaveLength(3);
    expect(res.hasMore).toBe(false);
    expect(res.totals.queues).toBe(3);
  });

  it('«застрявшие» считаются по всем элементам в работе, а не по показанной странице', async () => {
    const long = new Date(Date.now() - 1000 * 60 * 60 * 48);
    const prisma = queuesPrisma(3);
    prisma.mediaReviewQueueItem.findMany = async () => [
      { status: 'PROCESSING', createdAt: long, conversation: null },
      { status: 'PROCESSING', createdAt: long, conversation: { updatedAt: new Date() } },
      { status: 'PROCESSING', createdAt: long, conversation: null },
    ];
    const service = new AdminDomainsService(prisma, {} as any);

    const res = await service.mediaReviewQueues('op');

    // Вопрос «что застряло» не имеет смысла в границах страницы.
    expect(res.totals.stuckProcessing).toBe(2);
  });
});
