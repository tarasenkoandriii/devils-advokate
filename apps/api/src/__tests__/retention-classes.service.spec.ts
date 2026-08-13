import { RetentionClassService } from '../retention-classes/retention-classes.service';

function createFakePrisma() {
  const classes: any[] = [];

  return {
    _seed(rc: any) { classes.push(rc); },
    retentionClass: {
      findMany: async () => [...classes].sort((a, b) => a.classKey.localeCompare(b.classKey)),
    },
  };
}

describe('RetentionClassService', () => {
  it('list() возвращает все политики, отсортированные по classKey', async () => {
    const prisma = createFakePrisma();
    prisma._seed({ classKey: 'SHARE_LOG', displayName: 'Журнал Safe Share', defaultRetentionDays: 180 });
    prisma._seed({ classKey: 'AUDIT_LOG', displayName: 'Журнал безопасности', defaultRetentionDays: 365 });

    const service = new RetentionClassService(prisma as any);
    const list = await service.list();

    expect(list.length).toBe(2);
    expect(list[0].classKey).toBe('AUDIT_LOG');
    expect(list[1].classKey).toBe('SHARE_LOG');
  });

  it('list() возвращает пустой массив, если справочник не засеян', async () => {
    const prisma = createFakePrisma();
    const service = new RetentionClassService(prisma as any);

    const list = await service.list();
    expect(list.length).toBe(0);
  });
});
