// Docker dev-запуск (DOCKER.md) — тесты на dev-вход в админку.
//
// Что здесь проверяется по существу: dev-вход — это дыра в
// аутентификации, открытая НАМЕРЕННО и ровно в одном окружении.
// Значит тестировать нужно не «работает ли вход» (это тривиально), а
// границы: что он закрыт при любом наборе переменных, кроме одного, и
// что открытым он остаётся ровно настолько, насколько задумано (не
// обходит блокировку пользователя).

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { isDevAuthAllowed, devTelegramId } from '../admin-auth/dev-login';

function createFakePrisma() {
  const usersByTelegramId = new Map<string, any>();
  const usersById = new Map<string, any>();
  const sessions: any[] = [];
  let idCounter = 0;

  return {
    _seedUser(u: any) {
      const user = {
        isLibraryModerator: false,
        isVenueModerator: false,
        isOperator: false,
        isBlocked: false,
        ...u,
      };
      usersByTelegramId.set(user.telegramId, user);
      usersById.set(user.id, user);
      return user;
    },
    _getUser(telegramId: string) {
      return usersByTelegramId.get(telegramId);
    },
    _getSessions() {
      return sessions;
    },
    user: {
      upsert: async ({ where, create, update }: any) => {
        const existing = usersByTelegramId.get(where.telegramId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const user = {
          id: `u-${++idCounter}`,
          isLibraryModerator: false,
          isVenueModerator: false,
          isOperator: false,
          isBlocked: false,
          ...create,
        };
        usersByTelegramId.set(user.telegramId, user);
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
      deleteMany: async () => ({ count: 0 }),
    },
  };
}

function makeService(prisma: any) {
  const config = { getOrThrow: () => 'unused-bot-token' } as any;
  return new AdminAuthService(prisma as any, config);
}

describe('isDevAuthAllowed — граница включения dev-входа', () => {
  it('открыт ТОЛЬКО при ALLOW_DEV_AUTH=true и NODE_ENV!=production', () => {
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true', NODE_ENV: undefined })).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ALLOW_DEV_AUTH=true в проде НЕ открывает вход — второй предохранитель держит', () => {
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'production' })).toBe(false);
  });

  it('никакое «почти true» не считается за true (строка, не Boolean-приведение)', () => {
    for (const value of ['True', 'TRUE', '1', 'yes', 'on', '', undefined]) {
      expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: value, NODE_ENV: 'development' })).toBe(false);
    }
  });
});

describe('AdminAuthService.devLogin', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function enableDevAuth() {
    process.env.ALLOW_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'development';
  }

  it('отвечает 404 (не 403), когда dev-вход выключен — эндпоинт не должен выглядеть существующим', async () => {
    process.env.ALLOW_DEV_AUTH = 'false';
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    await expect(service.devLogin('123')).rejects.toThrow(NotFoundException);
    expect(prisma._getSessions().length).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: при NODE_ENV=production не пускает даже с ALLOW_DEV_AUTH=true', async () => {
    process.env.ALLOW_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'production';
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    await expect(service.devLogin('123')).rejects.toThrow(NotFoundException);
    expect(prisma._getSessions().length).toBe(0);
  });

  it('создаёт сессию и выдаёт все три флага доступа — иначе админка показала бы четыре экрана «нет доступа»', async () => {
    enableDevAuth();
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const result = await service.devLogin('123');

    expect(result.token).toHaveLength(64); // 32 байта hex
    expect(prisma._getSessions().length).toBe(1);

    const user = prisma._getUser('dev-123');
    expect(user.isOperator).toBe(true);
    expect(user.isLibraryModerator).toBe(true);
    expect(user.isVenueModerator).toBe(true);
  });

  it('использует тот же неймспейс telegramId, что и dev-bypass TMA — один пользователь на оба входа', async () => {
    enableDevAuth();
    const prisma = createFakePrisma();
    // Пользователь, «созданный ранее из TMA» через X-Dev-User-Id: 123 —
    // без прав, как и создаёт его TelegramAuthGuard.tryDevBypass().
    prisma._seedUser({ id: 'from-tma', telegramId: devTelegramId('123') });
    const service = makeService(prisma);

    await service.devLogin('123');

    // Новый пользователь НЕ создан, права доставлены существующему.
    const session = prisma._getSessions()[0];
    expect(session.userId).toBe('from-tma');
    expect(prisma._getUser('dev-123').isOperator).toBe(true);
  });

  it('acceptance-тест: dev-вход НЕ обходит полную блокировку аккаунта (isBlocked)', async () => {
    enableDevAuth();
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'blocked', telegramId: 'dev-123', isBlocked: true });
    const service = makeService(prisma);

    await expect(service.devLogin('123')).rejects.toThrow(UnauthorizedException);
    expect(prisma._getSessions().length).toBe(0);
  });

  it('пустой devUserId падает обратно на 123 — то же значение по умолчанию, что в TMA и сиде', async () => {
    enableDevAuth();
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    await service.devLogin('   ');

    expect(prisma._getUser('dev-123')).toBeDefined();
  });

  it('сессия живёт 7 дней — тот же TTL, что у настоящего входа, не «вечная» дев-сессия', async () => {
    enableDevAuth();
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const before = Date.now();
    const { expiresAt } = await service.devLogin('123');

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - before).toBeGreaterThan(sevenDaysMs - 5000);
    expect(expiresAt.getTime() - before).toBeLessThan(sevenDaysMs + 5000);
  });
});
