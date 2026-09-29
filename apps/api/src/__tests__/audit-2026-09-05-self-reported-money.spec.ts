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
  return {
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
  };
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

  it('вчерашняя отметка не мешает сегодняшней', async () => {
    // Ограничение — на день, а не навсегда: человек может бывать в
    // заведении не один раз.
    const s = setup();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    s.prisma._seedConfirmation({ approvedVenueId: 'v1', confirmedByUserId: 'me', createdAt: yesterday });
    await s.service.confirmBooking('me', 'v1');
    expect(s.prisma._confirmations()).toHaveLength(2);
  });
});
