import { UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { TelegramLoginWidgetPayload } from '../telegram-auth/telegram-login-widget.util';

const BOT_TOKEN = 'test-bot-token-12345';

// Сгенерирован тем же скриптом/алгоритмом, что и в telegram-login-widget.spec.ts —
// { id: 555000111, first_name: 'Login', auth_date: 1786844663 }.
const VALID_PAYLOAD: TelegramLoginWidgetPayload = {
  id: 555000111,
  first_name: 'Login',
  auth_date: 1786844663,
  hash: 'e82aed71f850b9034b99ded51d0b1a973682c91f7bfd600fd3cfe5dcbefd6d30',
};

function createFakePrisma() {
  const users = new Map<string, any>();
  const usersById = new Map<string, any>();
  const sessions: any[] = [];
  let idCounter = 0;

  return {
    _seedUser(u: any) {
      const user = { isLibraryModerator: false, isVenueModerator: false, isOperator: false, ...u };
      users.set(user.telegramId, user);
      usersById.set(user.id, user);
    },
    _getSessions() {
      return sessions;
    },

    user: {
      upsert: async ({ where, create }: any) => {
        const existing = users.get(where.telegramId);
        if (existing) return existing;
        const user = {
          id: `u-${++idCounter}`,
          isLibraryModerator: false,
          isVenueModerator: false,
          isOperator: false,
          ...create,
        };
        users.set(user.telegramId, user);
        usersById.set(user.id, user);
        return user;
      },
      findUnique: async ({ where }: any) => usersById.get(where.id) ?? null,
    },
    adminSession: {
      create: async ({ data }: any) => {
        const s = { id: `s-${++idCounter}`, createdAt: new Date(), ...data };
        sessions.push(s);
        return s;
      },
      deleteMany: async ({ where }: any) => {
        const before = sessions.length;
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i].token === where.token) sessions.splice(i, 1);
        }
        return { count: before - sessions.length };
      },
    },
  };
}

function makeService(prisma: any) {
  // get() — для опциональной ADMIN_LOGIN_BOT_TOKEN (повторный аудит
  // 2026-08-31): не задана ⇒ используется общий TELEGRAM_BOT_TOKEN.
  const config = { get: (_key: string) => undefined, getOrThrow: (_key: string) => BOT_TOKEN } as any;
  return new AdminAuthService(prisma as any, config);
}

describe('AdminAuthService', () => {
  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1786844663_000 + 5000);
  });
  afterAll(() => {
    (Date.now as jest.Mock).mockRestore();
  });

  it('acceptance-тест §5.1 (первый сценарий): вход не требует никаких прав, создаёт сессию для обычного пользователя без флагов', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const result = await service.loginWithTelegram(VALID_PAYLOAD);

    expect(result.token).toBeDefined();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const session = prisma._getSessions()[0];
    const me = await service.me(session.userId);
    expect(me.isLibraryModerator).toBe(false);
    expect(me.isVenueModerator).toBe(false);
    expect(me.isOperator).toBe(false);
  });

  it('устанавливает expiresAt ровно на 7 дней вперёд (ТЗ §4.1)', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const result = await service.loginWithTelegram(VALID_PAYLOAD);

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result.expiresAt.getTime() - Date.now()).toBeCloseTo(sevenDaysMs, -3);
  });

  it('отклоняет вход с испорченной подписью payload', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);
    const tampered = { ...VALID_PAYLOAD, hash: 'f'.repeat(64) };

    await expect(service.loginWithTelegram(tampered)).rejects.toThrow(UnauthorizedException);
  });

  it('повторный вход тем же telegramId переиспользует существующего User, не создаёт дубликат', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    await service.loginWithTelegram(VALID_PAYLOAD);
    await service.loginWithTelegram(VALID_PAYLOAD);

    const sessions = prisma._getSessions();
    expect(sessions.length).toBe(2); // две сессии
    expect(sessions[0].userId).toBe(sessions[1].userId); // но один и тот же пользователь
  });

  it('logout удаляет сессию по token', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);
    const { token } = await service.loginWithTelegram(VALID_PAYLOAD);

    expect(prisma._getSessions().length).toBe(1);
    await service.logout(token);
    expect(prisma._getSessions().length).toBe(0);
  });

  it('acceptance-тест (НАЙВАЖЛИВІШИЙ, Пункт [full-block]): loginWithTelegram відхиляє вхід заблокованого користувача, окремий вхід не стає обхідним шляхом', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'blocked-1', telegramId: '555000111', isBlocked: true });
    const service = makeService(prisma);

    await expect(service.loginWithTelegram(VALID_PAYLOAD)).rejects.toThrow(UnauthorizedException);
    expect(prisma._getSessions().length).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-31): ADMIN_LOGIN_BOT_TOKEN имеет приоритет — вход через отдельного бота', async () => {
    // Сценарий из реальной настройки: домен админки привязан к своему
    // боту (/setdomain — один домен на бота), а Mini App живёт на
    // другом. Подпись виджета проверяется токеном ИМЕННО того бота, чью
    // кнопку нажали, поэтому одного TELEGRAM_BOT_TOKEN тут не хватает.
    const prisma = createFakePrisma();
    const config = {
      get: (key: string) => (key === 'ADMIN_LOGIN_BOT_TOKEN' ? BOT_TOKEN : undefined),
      // Токен основного бота другой — если сервис возьмёт его, подпись
      // не сойдётся и вход упадёт.
      getOrThrow: () => 'token-of-a-different-bot',
    } as any;
    const service = new AdminAuthService(prisma as any, config);

    const result = await service.loginWithTelegram(VALID_PAYLOAD);
    expect(result.token).toBeDefined();
  });

  it('без ADMIN_LOGIN_BOT_TOKEN используется общий TELEGRAM_BOT_TOKEN — поведение по умолчанию не меняется', async () => {
    const prisma = createFakePrisma();
    const config = {
      get: () => undefined,
      getOrThrow: () => BOT_TOKEN,
    } as any;
    const service = new AdminAuthService(prisma as any, config);

    await expect(service.loginWithTelegram(VALID_PAYLOAD)).resolves.toBeDefined();
  });

  it('пустая строка в ADMIN_LOGIN_BOT_TOKEN не считается заданной — падаем обратно на общий токен', async () => {
    const prisma = createFakePrisma();
    const config = {
      get: (key: string) => (key === 'ADMIN_LOGIN_BOT_TOKEN' ? '   ' : undefined),
      getOrThrow: () => BOT_TOKEN,
    } as any;
    const service = new AdminAuthService(prisma as any, config);

    await expect(service.loginWithTelegram(VALID_PAYLOAD)).resolves.toBeDefined();
  });

  it('me() возвращает реальные флаги доступа пользователя, когда они выставлены', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op-1', telegramId: '555000111', isOperator: true, isLibraryModerator: true });
    const service = makeService(prisma);

    const me = await service.me('op-1');

    expect(me.isOperator).toBe(true);
    expect(me.isLibraryModerator).toBe(true);
    expect(me.isVenueModerator).toBe(false);
  });
});
