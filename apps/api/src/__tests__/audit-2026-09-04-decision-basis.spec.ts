// Сверка оснований 2026-09-04, серверная половина — решение о человеке
// без причины и без объяснения ему.
//
// Продукт требует основание везде: позиция без цитаты не создаётся, факт
// без источника не сохраняется, слияние отчитывается о потерянном. И при
// этом РЕШЕНИЕ О ЧЕЛОВЕКЕ — отнять девять действий или вход целиком —
// принималось с `note?: string` и уходило в базу как `null`. Журнал
// фиксировал, ЧТО сделано, и мог не знать, за что.
//
// Вторая половина: причина в базе была, а человеку не показывалась
// никогда. Он узнавал только факт — доступ закрыт, — и отправлялся
// «в поддержку», которой в продукте нет: поиск по монорепо находит
// ровно две строки с этим словом, и обе — сами эти сообщения. Право без
// адреса, та же форма, что в пункте [candidate-rights].

import { BadRequestException } from '@nestjs/common';
import { AdminUsersService, MIN_MODERATION_REASON_LETTERS } from '../admin-users/admin-users.service';
import { blockedNotice, restrictedNotice } from '../telegram-auth/moderation-notice';

/** Минимальная база на память: этой сверке нужны только пользователи и
 * удаление сессий при блокировке. Общий `fake-prisma` знает про наём и
 * ничего не знает про модерацию аккаунтов, а фейк из
 * `admin-users.service.spec` живёт внутри того файла. */
function fakeUsers() {
  const users = new Map<string, any>();
  return {
    _seedUser(u: any) {
      users.set(u.id, {
        isOperator: false,
        isRestricted: false,
        restrictedAt: null,
        restrictedNote: null,
        isBlocked: false,
        blockedAt: null,
        blockedNote: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        ...u,
      });
    },
    _getUser(id: string) {
      return users.get(id);
    },
    adminSession: { deleteMany: async () => ({ count: 0 }) },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(users.get(where.id), data),
    },
  };
}

function setup() {
  const prisma = fakeUsers();
  prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
  prisma._seedUser({ id: 'target', telegramId: 'target' });
  const auditLog = { records: [] as any[], record: async (r: any) => { auditLog.records.push(r); return r; } };
  return { prisma, auditLog, service: new AdminUsersService(prisma as any, auditLog as any) };
}

describe('Основание решения: продукт не действует на человека молча', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ограничить без причины нельзя', async () => {
    const s = setup();
    await expect(s.service.restrictUser('op1', 'target', true)).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.restrictUser('op1', 'target', true, '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.restrictUser('op1', 'target', true, '.')).rejects.toBeInstanceOf(BadRequestException);
    // И отказ не оставил половины: флаг не выставлен.
    expect(s.prisma._getUser('target').isRestricted).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: заблокировать без причины тоже нельзя', async () => {
    const s = setup();
    await expect(s.service.blockUser('op1', 'target', true)).rejects.toBeInstanceOf(BadRequestException);
    expect(s.prisma._getUser('target').isBlocked).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: короткое настоящее слово — причина; «ок» и точка — нет', async () => {
    // Порог проверяет НАЛИЧИЕ основания, а не длину мысли. Первая версия
    // требовала десяти символов и уронила существующий тест с причиной
    // «спам» — причина была права, порог нет.
    const s = setup();
    const updated = await s.service.restrictUser('op1', 'target', true, 'спам');
    expect(updated.isRestricted).toBe(true);
    expect(updated.restrictedNote).toBe('спам');
    expect(MIN_MODERATION_REASON_LETTERS).toBeLessThanOrEqual(4);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: СНЯТЬ ограничение можно без причины — исправлять ошибку нельзя затруднять', async () => {
    // Обратная половина правила. Требовать основание, чтобы вернуть
    // человеку доступ, значило бы поставить преграду ровно там, где её
    // быть не должно.
    const s = setup();
    await s.service.restrictUser('op1', 'target', true, 'спам');
    const lifted = await s.service.restrictUser('op1', 'target', false);
    expect(lifted.isRestricted).toBe(false);
    expect(lifted.restrictedNote).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: причина попадает в журнал — решение восстановимо как факт', async () => {
    const s = setup();
    await s.service.restrictUser('op1', 'target', true, 'аномальный паттерн');
    const rec = s.auditLog.records.find((r) => r.action === 'user.restricted');
    expect(rec.after).toMatchObject({ restrictedNote: 'аномальный паттерн' });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: человеку сообщают основание, а не только факт закрытия', () => {
    const blocked = blockedNotice({ blockedNote: 'повторные нарушения', blockedAt: new Date('2026-09-01T10:00:00Z') }, {} as never);
    expect(blocked).toMatch(/Основание: повторные нарушения/);
    expect(blocked).toMatch(/2026/); // дата решения названа
    expect(blocked).toMatch(/Запись о решении сохраняется/);

    const restricted = restrictedNotice({ restrictedNote: 'спам в библиотеке', restrictedAt: null }, {} as never);
    expect(restricted).toMatch(/Основание: спам в библиотеке/);
    // Ограничение — не блокировка: человеку сказано, что осталось, иначе
    // он решит, что потерял всё.
    expect(restricted).toMatch(/чтение и выгрузка ваших данных работают/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: несуществующий канал обжалования не называется, настроенный — называется', () => {
    // Названный и несуществующий способ хуже неназванного: человек ищет
    // и не находит.
    const without = blockedNotice({ blockedNote: 'причина' }, {} as never);
    expect(without).not.toMatch(/поддержк|напишите/i);

    const withContact = blockedNotice({ blockedNote: 'причина' }, { SUPPORT_CONTACT: '@dev_support' } as never);
    expect(withContact).toMatch(/@dev_support/);
    expect(withContact).toMatch(/считаете решение ошибкой/);
  });

  it('дата, которой нет, не превращается в «Invalid Date»', () => {
    const notice = blockedNotice({ blockedNote: 'причина', blockedAt: null }, {} as never);
    expect(notice).not.toMatch(/Invalid/);
    expect(notice).toMatch(/Основание: причина/);
  });
});
