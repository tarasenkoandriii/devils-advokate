import { ForbiddenException } from '@nestjs/common';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';

function makeContext(request: any): any {
  return { switchToHttp: () => ({ getRequest: () => request }) };
}

describe('NotRestrictedGuard', () => {
  it('acceptance-тест: пропускає запит, коли userRestricted не встановлено (звичайний користувач)', () => {
    const guard = new NotRestrictedGuard();
    const result = guard.canActivate(makeContext({ userId: 'u1' }));

    expect(result).toBe(true);
  });

  it('пропускає запит, коли userRestricted=false явно', () => {
    const guard = new NotRestrictedGuard();
    const result = guard.canActivate(makeContext({ userId: 'u1', userRestricted: false }));

    expect(result).toBe(true);
  });

  it('acceptance-тест (НАЙВАЖЛИВІШИЙ, devils-advocate-admin-panel-tz.md §4.3): відхиляє з ForbiddenException, коли userRestricted=true', () => {
    const guard = new NotRestrictedGuard();

    expect(() => guard.canActivate(makeContext({ userId: 'u1', userRestricted: true }))).toThrow(ForbiddenException);
  });

  it('повідомлення про помилку зрозуміле, не технічний код — той самий принцип, що §4.3 ТЗ ("отклонять с понятным сообщением")', () => {
    const guard = new NotRestrictedGuard();

    try {
      guard.canActivate(makeContext({ userId: 'u1', userRestricted: true }));
      throw new Error('expected canActivate to throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message.length).toBeGreaterThan(10);
    }
  });
});
