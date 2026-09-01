import { ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { AdminSessionGuard, isOriginAllowed } from '../admin-auth/admin-session.guard';

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

function makeContext(cookieHeader?: string, opts: { method?: string; origin?: string } = {}): ExecutionContext {
  const request: any = { method: opts.method ?? 'GET', headers: { cookie: cookieHeader, origin: opts.origin } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminSessionGuard — CSRF (Пункт [project-audit] 2026-09-01)', () => {
  afterEach(() => {
    delete process.env.CORS_ORIGIN;
  });

  it('КЛЮЧЕВОЙ ТЕСТ: cross-site POST с чужим Origin — 403 ещё ДО проверки cookie (сценарий rollback-эксплойта из отчёта)', async () => {
    process.env.CORS_ORIGIN = 'https://admin.example.com,https://tma.example.com';
    const prisma = createFakePrisma();
    prisma._seedSession({ token: 't1', userId: 'u1', expiresAt: new Date(Date.now() + 10_000) });
    const guard = new AdminSessionGuard(prisma as any);

    await expect(
      guard.canActivate(makeContext('admin_session=t1', { method: 'POST', origin: 'https://evil.example.org' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('легитимный cross-origin POST с админского домена из allowlist проходит; GET не проверяется вовсе', async () => {
    process.env.CORS_ORIGIN = 'https://admin.example.com';
    const prisma = createFakePrisma();
    prisma._seedSession({ token: 't1', userId: 'u1', expiresAt: new Date(Date.now() + 10_000) });
    const guard = new AdminSessionGuard(prisma as any);

    await expect(guard.canActivate(makeContext('admin_session=t1', { method: 'POST', origin: 'https://admin.example.com' }))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext('admin_session=t1', { method: 'GET', origin: 'https://evil.example.org' }))).resolves.toBe(true);
  });

  it('границы isOriginAllowed: без Origin (curl) — пропуск; без CORS_ORIGIN (dev) — выключено; трейлинг-слэш нормализуется', () => {
    expect(isOriginAllowed('POST', undefined, 'https://a.com')).toBe(true);
    expect(isOriginAllowed('POST', 'https://evil.com', undefined)).toBe(true);
    expect(isOriginAllowed('POST', 'https://a.com/', 'https://a.com')).toBe(true);
    expect(isOriginAllowed('DELETE', 'https://evil.com', 'https://a.com')).toBe(false);
  });
});

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
