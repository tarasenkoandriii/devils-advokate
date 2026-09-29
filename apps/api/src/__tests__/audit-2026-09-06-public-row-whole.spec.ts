// Сверка 2026-09-06 — публичная витрина отдавала строку целиком.
//
// НАЙДЕННОЕ. `GET /public/venues` и `GET /public/venues/:id` —
// контроллер БЕЗ АУТЕНТИФИКАЦИИ ВООБЩЕ, и это намеренно: «публичная
// карточка», буквально §3.23 ТЗ. Сервис под ним возвращал
// `approvedVenue.findMany({ orderBy })` — строку целиком. Вместе с
// названием, адресом и телефоном наружу уходило:
//
//  • `referralFeeAmount` — сумма реферальной платы, СОГЛАСОВАННАЯ С
//    КОНКРЕТНЫМ ЗАВЕДЕНИЕМ. Коммерческое условие между продуктом и
//    заведением, доступное кому угодно в интернете: соседнее заведение
//    видит, сколько платит это, а это — что платит больше соседнего.
//    Сама схема называет это поле «леджером к оплате заведением»;
//  • `applicationId` — ссылка на заявку, которая публичной не является.
//
// Экран эти поля не показывал. Но «не показываем» и «не отдаём» —
// разные вещи: по HTTP их читал кто угодно, а тип клиента их ещё и
// объявлял.
//
// ЧЕСТНО О СОБСТВЕННОМ ИЗМЕРЕНИИ. Две сверки назад ось «внутреннее
// поле уезжает в клиент» была измерена и названа ЧИСТОЙ. Она и была
// чистой — по тому шаблону, которым я мерил: токены, секреты, хэши,
// биометрия. Денежного поля в шаблоне не было, и целая строка на
// публичном эндпоинте прошла мимо. Вывод не про этот баг, а про
// измерение: список «что считается чувствительным» задавался по
// названиям полей, а надо было по ПОВЕРХНОСТИ — что вообще уходит
// туда, где нет аутентификации.
//
// И ВТОРОЕ: правка снова не уронила ни одного теста. Публичная выдача
// не была покрыта ничем — как и область видимости фактов в предыдущей
// сверке. Поэтому проверка ниже поведенческая: она зовёт сервис с
// заглушкой, у которой в строке ЕСТЬ и комиссия, и ссылка на заявку, и
// смотрит, что наружу они не вышли.

import { NotFoundException } from '@nestjs/common';
import { VenueApplicationService } from '../venue-application/venue-application.service';

/** Заглушка строки БОГАЧЕ, чем публичный ответ: если сервис просто
 * вернёт то, что дала база, тест это увидит. Поэтому `select`
 * применяется здесь так же, как его применил бы Prisma. */
function createFakePrisma() {
  const row: Record<string, unknown> = {
    id: 'venue-1',
    applicationId: 'app-1',
    name: 'Кофейня на углу',
    address: 'Киев, ул. Примерная, 1',
    phone: '+380000000000',
    openingHours: ['пн-пт 9:00-20:00'],
    photoReferences: ['ref-1'],
    rating: 4.5,
    referralFeeAmount: 250,
    isPriorityPartner: true,
    createdAt: new Date('2026-09-01'),
    updatedAt: new Date('2026-09-01'),
  };
  const project = (select?: Record<string, boolean>) => {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(select)) out[k] = row[k];
    return out;
  };
  return {
    _row: row,
    approvedVenue: {
      findMany: async ({ select }: any) => [project(select)],
      findUnique: async ({ where, select }: any) => (where.id === 'venue-1' ? project(select) : null),
    },
  };
}

const service = () => new VenueApplicationService(createFakePrisma() as never, {} as never, {} as never);

describe('Сверка [public-row-whole]: витрина без аутентификации отдаёт только карточку', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: комиссия, согласованная с заведением, наружу не уходит', async () => {
    const [venue] = await service().listApprovedVenues();
    expect(venue).not.toHaveProperty('referralFeeAmount');
    const one = await service().getApprovedVenue('venue-1');
    expect(one).not.toHaveProperty('referralFeeAmount');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ссылка на заявку тоже не уходит — сама заявка не публичная', async () => {
    const [venue] = await service().listApprovedVenues();
    expect(venue).not.toHaveProperty('applicationId');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: набор полей витрины перечислен поимённо и не «всё, кроме»', async () => {
    const [venue] = await service().listApprovedVenues();
    expect(Object.keys(venue).sort()).toEqual(
      ['address', 'createdAt', 'id', 'isPriorityPartner', 'name', 'openingHours', 'phone', 'photoReferences', 'rating'].sort(),
    );
  });

  it('пометка «реклама» из витрины не пропала — правка не забрала лишнего', async () => {
    const [venue] = await service().listApprovedVenues();
    expect(venue.isPriorityPartner).toBe(true);
    expect(venue.name).toBe('Кофейня на углу');
  });

  it('отсутствующее заведение по-прежнему 404, а не пустая карточка', async () => {
    await expect(service().getApprovedVenue('нет-такого')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('проверка не вырождена: в самой строке комиссия есть — значит её убрал именно сервис', () => {
    expect(createFakePrisma()._row).toHaveProperty('referralFeeAmount', 250);
  });
});
