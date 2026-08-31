import { UnauthorizedException } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';

function makeConfig(values: Record<string, string>) {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing config ${key}`);
      return values[key];
    },
  };
}

function makeContext(request: any): any {
  return { switchToHttp: () => ({ getRequest: () => request }) };
}

function makeFakePrisma(user: { id: string; isRestricted: boolean; isBlocked: boolean }) {
  return {
    user: {
      upsert: async () => user,
    },
  };
}

function makeCapturingPrisma(user: { id: string; isRestricted: boolean; isBlocked: boolean }) {
  const calls: any[] = [];
  return {
    calls,
    user: {
      upsert: async (args: any) => { calls.push(args); return user; },
    },
  };
}

describe('TelegramAuthGuard (isBlocked, dev-bypass шлях)', () => {
  it('acceptance-тест (НАЙВАЖЛИВІШИЙ, Пункт [full-block]): isBlocked=true відхиляє запит ЦІЛКОМ, до видачі userId', async () => {
    const config = makeConfig({ ALLOW_DEV_AUTH: 'true' });
    const prisma = makeFakePrisma({ id: 'u1', isRestricted: false, isBlocked: true });
    const guard = new TelegramAuthGuard(config as any, prisma as any);
    const request: any = { headers: { 'x-dev-user-id': '123' } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(UnauthorizedException);
    expect(request.userId).toBeUndefined();
  });

  it('isRestricted=true БЕЗ isBlocked — запит проходить, тільки сигналізує (не блокує)', async () => {
    const config = makeConfig({ ALLOW_DEV_AUTH: 'true' });
    const prisma = makeFakePrisma({ id: 'u1', isRestricted: true, isBlocked: false });
    const guard = new TelegramAuthGuard(config as any, prisma as any);
    const request: any = { headers: { 'x-dev-user-id': '123' } };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(true);
    expect(request.userId).toBe('u1');
    expect(request.userRestricted).toBe(true);
  });

  it('звичайний користувач (обидва false) — запит проходить без обмежень', async () => {
    const config = makeConfig({ ALLOW_DEV_AUTH: 'true' });
    const prisma = makeFakePrisma({ id: 'u1', isRestricted: false, isBlocked: false });
    const guard = new TelegramAuthGuard(config as any, prisma as any);
    const request: any = { headers: { 'x-dev-user-id': '123' } };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(true);
    expect(request.userRestricted).toBe(false);
  });
});

describe('TelegramAuthGuard — readVercelIpCountry() / ipCountryCode (аудит юрисдикції 2026-08-30)', () => {
  it('валідний x-vercel-ip-country передається в upsert як ipCountryCode (create і update)', async () => {
    const config = makeConfig({ ALLOW_DEV_AUTH: 'true' });
    const prisma = makeCapturingPrisma({ id: 'u1', isRestricted: false, isBlocked: false });
    const guard = new TelegramAuthGuard(config as any, prisma as any);
    const request: any = { headers: { 'x-dev-user-id': '123', 'x-vercel-ip-country': 'ua' } };

    await guard.canActivate(makeContext(request));

    expect(prisma.calls).toHaveLength(1);
    expect(prisma.calls[0].create.ipCountryCode).toBe('UA');
    expect(prisma.calls[0].update.ipCountryCode).toBe('UA');
  });

  it('XX / відсутній заголовок / сміття — ipCountryCode НЕ пишеться (update={}), не перезаписує старе значення сміттям', async () => {
    const config = makeConfig({ ALLOW_DEV_AUTH: 'true' });
    for (const headerValue of [undefined, 'XX', 'USA', '']) {
      const prisma = makeCapturingPrisma({ id: 'u1', isRestricted: false, isBlocked: false });
      const guard = new TelegramAuthGuard(config as any, prisma as any);
      const headers: Record<string, string> = { 'x-dev-user-id': '123' };
      if (headerValue !== undefined) headers['x-vercel-ip-country'] = headerValue;
      await guard.canActivate(makeContext({ headers }));

      expect(prisma.calls[0].update).toEqual({});
      expect(prisma.calls[0].create.ipCountryCode ?? null).toBeNull();
    }
  });

  it('оновлюється КОЖЕН запит (не тільки при створенні) — щоб не залипати на першому значенні при VPN/поїздках', async () => {
    const config = makeConfig({ ALLOW_DEV_AUTH: 'true' });
    const prisma = makeCapturingPrisma({ id: 'u1', isRestricted: false, isBlocked: false });
    const guard = new TelegramAuthGuard(config as any, prisma as any);

    await guard.canActivate(makeContext({ headers: { 'x-dev-user-id': '123', 'x-vercel-ip-country': 'de' } }));
    await guard.canActivate(makeContext({ headers: { 'x-dev-user-id': '123', 'x-vercel-ip-country': 'fr' } }));

    expect(prisma.calls[0].update.ipCountryCode).toBe('DE');
    expect(prisma.calls[1].update.ipCountryCode).toBe('FR');
  });
});
