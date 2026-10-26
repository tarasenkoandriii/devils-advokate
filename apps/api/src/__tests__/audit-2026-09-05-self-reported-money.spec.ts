// Сверка 2026-09-05 — самоотчёт, показанный как сумма к оплате.
//
// НАЙДЕННОЕ.
//
//  1. `confirmBooking` создавал строку на КАЖДЫЙ вызов. Человек мог
//     нажать «я забронировал это место» десять раз подряд — и сумма,
//     которую оператор видит для заведения, вырастала в десять раз.
//     Тот же изъян, что в пункте [click-count], только последствие
//     денежное и касается третьей стороны — заведения, которое об этой
//     цифре не знает и ничего не подтверждало.
//  2. Оператор видел «N броней · M к оплате» — вид бухгалтерского факта.
//     Что обе цифры собраны из самоотчётов пользователей, было написано
//     только в комментарии к коду и в общей шапке страницы про
//     отсутствие платёжной инфраструктуры. Про ПРОИСХОЖДЕНИЕ чисел — ни
//     слова там, где эти числа стоят.
//  3. Сбой отметки сообщался ОДНОЙ ВИБРАЦИЕЙ: `catch { haptic('error') }`.
//     Человек нажал и не узнал ничего.
//
// ЧЕГО СВЕРКА НЕ ДЕЛАЕТ. Она не выдаёт ограничение «одна отметка в день»
// за проверку брони: продукт проверить бронь не может и делать вид, что
// может, не будет. Это защита от очевидного умножения, и названа она
// именно так.

import { BadRequestException } from '@nestjs/common';
import { VenueApplicationService } from '../venue-application/venue-application.service';

function fakePrisma() {
  const confirmations: any[] = [];
  let n = 0;
  const fake: any = {
    _confirmations() { return confirmations; },
    _seedConfirmation(c: any) {
      confirmations.push({ id: `b-${++n}`, createdAt: new Date(), referralFeeOwed: 100, ...c });
    },
    approvedVenue: {
      findUnique: async ({ where }: any) => (where.id === 'v1' ? { id: 'v1', referralFeeAmount: 100 } : null),
    },
    venueBookingConfirmation: {
      findFirst: async ({ where }: any) =>
        confirmations.find(
          (c) =>
            c.approvedVenueId === where.approvedVenueId &&
            c.confirmedByUserId === where.confirmedByUserId &&
            (!where.createdAt?.gte || c.createdAt >= where.createdAt.gte),
        ) ?? null,
      findMany: async ({ where }: any) => confirmations.filter((c) => c.approvedVenueId === where.approvedVenueId),
      create: async ({ data }: any) => {
        const row = { id: `b-${++n}`, createdAt: new Date(), ...data };
        confirmations.push(row);
        return row;
      },
    },
    user: { findUnique: async () => ({ isVenueModerator: true }) },
    scheduledConversation: { findFirst: async () => ({ id: 'sc1' }) },
    // Пункт [the-day-was-the-servers] 2026-10-26: отметка брони идёт
    // под замком — проверка «уже отмечал за сутки» и запись стали
    // одним событием (два нажатия удваивали сумму «к оплате»
    // заведению). Заглушка обязана знать интерактивную
    // транзакцию и сырой запрос замка.
    $executeRaw: async () => 1,
    $transaction: async (arg: any): Promise<any> => (typeof arg === 'function' ? arg(fake) : Promise.all(arg)),
  };
  return fake;
}

function setup() {
  const prisma = fakePrisma();
  return { prisma, service: new VenueApplicationService(prisma as any, {} as any, {} as any) };
}

describe('Деньги из самоотчёта: число не растёт от нажатий и не выдаётся за счёт', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: вторая отметка в тот же день отклоняется', async () => {
    const s = setup();
    await s.service.confirmBooking('me', 'v1');
    await expect(s.service.confirmBooking('me', 'v1')).rejects.toBeInstanceOf(BadRequestException);
    expect(s.prisma._confirmations()).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отказ объясняет, что это пометка, а не счёт заведению', async () => {
    const s = setup();
    await s.service.confirmBooking('me', 'v1');
    await expect(s.service.confirmBooking('me', 'v1')).rejects.toThrow(/не счёт заведению/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: другой человек в тот же день — не повтор', async () => {
    // Обратная половина: ограничение против умножения ОДНИМ человеком, а
    // не против того, что в заведение сходили двое.
    const s = setup();
    await s.service.confirmBooking('me', 'v1');
    await s.service.confirmBooking('someone-else', 'v1');
    expect(s.prisma._confirmations()).toHaveLength(2);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сводка несёт происхождение чисел, а не только числа', async () => {
    const s = setup();
    s.prisma._seedConfirmation({ approvedVenueId: 'v1', confirmedByUserId: 'a', referralFeeOwed: 100 });
    s.prisma._seedConfirmation({ approvedVenueId: 'v1', confirmedByUserId: 'b', referralFeeOwed: 100 });
    s.prisma._seedConfirmation({ approvedVenueId: 'v1', confirmedByUserId: 'b', referralFeeOwed: 100 });

    const summary = await s.service.getCommissionSummary('op', 'v1');
    expect(summary.totalBookingsConfirmed).toBe(3);
    expect(summary.basis).toBe('self-reported');
    // Сколько РАЗНЫХ людей отметились — цифра, по которой видно, что три
    // отметки могут быть не тремя бронями.
    expect(summary.distinctReporters).toBe(2);
  });

  it('отметка СТАРШЕ суток не мешает новой', async () => {
    // Ограничение — на сутки, а не навсегда: человек может бывать в
    // заведении не один раз.
    //
    // ПОПРАВКА, Пункт [the-day-was-the-servers] 2026-10-26: тест
    // назывался «вчерашняя отметка не мешает сегодняшней» и подкладывал
    // отметку РОВНО сутки назад (`setDate(-1)` сохраняет время). При
    // календарном дне это было «вчера»; теперь окно скользящее, и
    // ровно-сутки — это граница, а не «вчера». Смену смысла надо
    // назвать вслух, а не подогнать: ПРЕЖДЕ отметка в 23:00 не мешала
    // новой в 00:30 (другой календарный день), ТЕПЕРЬ мешает ещё 22
    // с половиной часа. Это и есть цена отказа от «дня», которого
    // сервер не знает: граница перестала зависеть от того, в каком
    // часовом поясе считает процесс.
    const s = setup();
    s.prisma._seedConfirmation({
      approvedVenueId: 'v1',
      confirmedByUserId: 'me',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await s.service.confirmBooking('me', 'v1');
    expect(s.prisma._confirmations()).toHaveLength(2);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отметка ВНУТРИ суток отклоняется и называет, через сколько можно', async () => {
    const s = setup();
    s.prisma._seedConfirmation({
      approvedVenueId: 'v1',
      confirmedByUserId: 'me',
      createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
    });
    await expect(s.service.confirmBooking('me', 'v1')).rejects.toThrow(/Отметить снова можно через 1 час/);
    expect(s.prisma._confirmations()).toHaveLength(1);
  });
});
