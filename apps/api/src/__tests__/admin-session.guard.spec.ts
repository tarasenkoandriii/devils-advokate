import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';

function createFakePrisma() {
  const sessions = new Map<string, any>();
  return {
    _seedSession(s: any) {
      // isBlocked по умолчанию false — guard читает его через
      // include: { user: { select: { isBlocked: true } } } (повторный
      // аудит 2026-08-30), поэтому мок обязан отдавать вложенного user,
      // а не только саму сессию.
      sessions.set(s.token, { ...s, user: { isBlocked: s.userBlocked ?? false } });
    },
    adminSession: {
      findUnique: async ({ where }: any) => sessions.get(where.token) ?? null,
    },
  };
}

function makeContext(cookieHeader?: string): ExecutionContext {
  const request: any = { headers: { cookie: cookieHeader } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminSessionGuard', () => {
  it('отклоняет запрос без cookie', async () => {
    const prisma = createFakePrisma();
    const guard = new AdminSessionGuard(prisma as any);

    await expect(guard.canActivate(makeContext(undefined))).rejects.toThrow(UnauthorizedException);
  });

  it('отклоняет запрос с несуществующим token в cookie', async () => {
    const prisma = createFakePrisma();
    const guard = new AdminSessionGuard(prisma as any);

    await expect(guard.canActivate(makeContext('admin_session=nonexistent-token'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('acceptance-тест §5.1 (второй сценарий): отклоняет запрос с просроченной сессией (401), не молчаливый показ пустых данных', async () => {
    const prisma = createFakePrisma();
    prisma._seedSession({
      token: 'expired-token',
      userId: 'u1',
      expiresAt: new Date(Date.now() - 1000),
    });
    const guard = new AdminSessionGuard(prisma as any);

    await expect(guard.canActivate(makeContext('admin_session=expired-token'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('пропускает запрос с валидной, ещё не просроченной сессией и кладёт userId в request', async () => {
    const prisma = createFakePrisma();
    prisma._seedSession({
      token: 'valid-token',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const guard = new AdminSessionGuard(prisma as any);
    const request: any = { headers: { cookie: 'admin_session=valid-token' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.userId).toBe('u1');
  });

  it('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-30): заблокированный пользователь не проходит по живой сессии', async () => {
    const prisma = createFakePrisma();
    prisma._seedSession({
      token: 'blocked-user-token',
      userId: 'u-blocked',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      userBlocked: true,
    });
    const guard = new AdminSessionGuard(prisma as any);

    // Раньше guard смотрел только на срок жизни токена: оператор,
    // заблокированный коллегой, сохранял доступ к админке до семи суток,
    // при том что TelegramAuthGuard его уже отсекал.
    await expect(guard.canActivate(makeContext('admin_session=blocked-user-token'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('корректно читает нужную cookie среди нескольких (не берёт первую попавшуюся)', async () => {
    const prisma = createFakePrisma();
    prisma._seedSession({
      token: 'the-real-token',
      userId: 'u2',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const guard = new AdminSessionGuard(prisma as any);
    const request: any = {
      headers: { cookie: 'other_cookie=abc; admin_session=the-real-token; another=xyz' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await guard.canActivate(context);
    expect(request.userId).toBe('u2');
  });
});
