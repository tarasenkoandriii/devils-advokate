import { LaunchDisclaimerService, CURRENT_DISCLAIMER_VERSION } from '../launch-disclaimer/launch-disclaimer.service';

function createFakePrisma() {
  const users = new Map<string, any>();

  return {
    _seedUser(u: any) { users.set(u.id, u); },
    user: {
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error('user not found');
        return u;
      },
      update: async ({ where, data }: any) => {
        const merged = { ...users.get(where.id), ...data };
        users.set(where.id, merged);
        return merged;
      },
    },
  };
}

const USER_ID = 'user-1';

describe('LaunchDisclaimerService', () => {
  it('getStatus() возвращает acknowledged=false для нового пользователя', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, launchDisclaimerAcknowledgedAt: null, launchDisclaimerVersion: null });
    const service = new LaunchDisclaimerService(prisma as any);

    const status = await service.getStatus(USER_ID);
    expect(status.acknowledged).toBe(false);
    expect(status.currentVersion).toBe(CURRENT_DISCLAIMER_VERSION);
  });

  it('acknowledge() выставляет acknowledged=true с текущей версией', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, launchDisclaimerAcknowledgedAt: null, launchDisclaimerVersion: null });
    const service = new LaunchDisclaimerService(prisma as any);

    const status = await service.acknowledge(USER_ID);
    expect(status.acknowledged).toBe(true);
    expect(status.acknowledgedVersion).toBe(CURRENT_DISCLAIMER_VERSION);
  });

  it('подтверждение СТАРОЙ версии не засчитывается как acknowledged для ТЕКУЩЕЙ (ключевая логика версионирования)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({
      id: USER_ID,
      launchDisclaimerAcknowledgedAt: new Date('2020-01-01'),
      launchDisclaimerVersion: 'v0-old-version-that-no-longer-exists',
    });
    const service = new LaunchDisclaimerService(prisma as any);

    const status = await service.getStatus(USER_ID);
    expect(status.acknowledged).toBe(false);
    expect(status.acknowledgedVersion).toBe('v0-old-version-that-no-longer-exists');
  });

  it('после acknowledge() повторный getStatus() тоже возвращает acknowledged=true', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, launchDisclaimerAcknowledgedAt: null, launchDisclaimerVersion: null });
    const service = new LaunchDisclaimerService(prisma as any);

    await service.acknowledge(USER_ID);
    const status = await service.getStatus(USER_ID);
    expect(status.acknowledged).toBe(true);
  });
});
