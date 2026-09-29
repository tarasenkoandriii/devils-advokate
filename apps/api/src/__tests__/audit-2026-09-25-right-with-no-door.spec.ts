// Пункт [right-with-no-door] 2026-09-25, серверная половина.
//
// Экранная половина — в `apps/tma/src/__tests__/right-with-no-door.spec.ts`,
// там разметка РИСУЕТСЯ. Здесь проверяется то, что можно проверить
// только на сервере: экран и выгрузка берут решения ИЗ ОДНОГО МЕСТА (и
// потому не разойдутся), заметка оператора не запрашивается вовсе, а
// потолок доезжает до ответа признаком, а не молчанием.

import { PrivacyCenterController } from '../privacy-center/privacy-center.controller';

type Row = { action: string; resource: string; resourceId: string; createdAt: Date };

/** Фейковая Prisma: считает запросы и отдаёт заданные строки.
 *
 * Фейк НАМЕРЕННО разрешающий — отказать здесь нечему, кроме самой
 * проверяемой логики. */
function makeService(opts: { account: Row[]; project: Row[]; projectIds?: string[]; belongings?: Row[] }) {
  const calls: Array<{ model: string; args: any }> = [];
  // Пункт [door-opened-onto-a-corner] 2026-09-25: область журнала описана
  // реестром, и видов записи в ней десять. Заглушка отвечает пустотой на
  // всё, кроме проектов: так проверки про аккаунт и проекты остаются
  // теми же, а третья группа проверяется отдельным сценарием.
  const empty = { findMany: () => Promise.resolve([] as Array<{ id: string }>) };
  const prisma: any = {
    libraryEntry: empty,
    venueApplication: empty,
    candidateProfile: empty,
    candidatePipelineStatus: empty,
    candidateShare: opts.belongings ? { findMany: () => Promise.resolve([{ id: 'sh-1' }]) } : empty,
    termsSheet: empty,
    offerDocument: empty,
    employerAgencyEngagement: empty,
    project: {
      findMany: (args: any) => {
        calls.push({ model: 'project', args });
        return Promise.resolve((opts.projectIds ?? ['p-1']).map((id) => ({ id })));
      },
    },
    auditLogEntry: {
      findMany: (args: any) => {
        calls.push({ model: 'auditLogEntry', args });
        const resources: string[] = (args.where.OR ?? []).map((w: any) => w.resource);
        if (resources.includes('User')) return Promise.resolve(opts.account);
        if (resources.includes('Project')) return Promise.resolve(opts.project);
        return Promise.resolve(opts.belongings ?? []);
      },
    },
  };
  const { PrivacyCenterService } = require('../privacy-center/privacy-center.service');
  const svc = Object.create(PrivacyCenterService.prototype);
  svc.prisma = prisma;
  return { svc, calls };
}

function rows(n: number, action = 'user.restricted', resource = 'User'): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    action,
    resource,
    resourceId: 'u-1',
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
  }));
}

describe('Пункт [right-with-no-door] 2026-09-25: решения о человеке — один источник', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: заметка оператора не запрашивается вовсе', async () => {
    const { svc, calls } = makeService({ account: rows(1), project: [] });
    await svc.readDecisions('u-1');
    const auditCalls = calls.filter((c) => c.model === 'auditLogEntry');
    // Пункт [door-opened-onto-a-corner]: групп три, но группа без единой
    // записи человека запроса не делает вовсе — здесь это аккаунт и
    // проекты.
    expect(auditCalls.length).toBe(2);
    for (const c of auditCalls) {
      // Поля выбираются ПОИМЁННО. `select` без `note` — это не то же
      // самое, что отбросить `note` после чтения: рабочая формулировка
      // оператора не должна покидать базу.
      expect(Object.keys(c.args.select).sort()).toEqual(['action', 'createdAt', 'resource', 'resourceId']);
      expect(JSON.stringify(c.args)).not.toMatch(/note|before|after/);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: решения о проектах отбираются по проектам ЭТОГО человека', async () => {
    const { svc, calls } = makeService({ account: [], project: rows(1, 'admin.project.frozen', 'Project'), projectIds: ['p-7', 'p-8'] });
    await svc.readDecisions('u-1');
    const orOf = (resource: string) =>
      calls
        .filter((c) => c.model === 'auditLogEntry')
        .flatMap((c) => c.args.where.OR as Array<{ resource: string; resourceId: { in: string[] } }>)
        .find((w) => w.resource === resource);
    expect(orOf('Project')!.resourceId).toEqual({ in: ['p-7', 'p-8'] });
    expect(orOf('User')!.resourceId).toEqual({ in: ['u-1'] });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: лишняя строка пробы съедается, а «есть ещё» доезжает', async () => {
    // Потолок 200; проба берёт 201. В ответ обязаны уйти 200 и признак.
    const { svc } = makeService({ account: rows(201), project: rows(3, 'admin.project.frozen', 'Project') });
    const out = await svc.readDecisions('u-1');
    expect(out.accountDecisions.items.length).toBe(200);
    expect(out.accountDecisions.hasMore).toBe(true);
    expect(out.accountDecisions.limit).toBe(200);
    expect(out.projectDecisions.items.length).toBe(3);
    expect(out.projectDecisions.hasMore).toBe(false);
  });

  it('обратная проба: ровно по потолку — «есть ещё» не выдумывается', async () => {
    const { svc } = makeService({ account: rows(200), project: [] });
    const out = await svc.readDecisions('u-1');
    expect(out.accountDecisions.items.length).toBe(200);
    expect(out.accountDecisions.hasMore).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: экран получает решения расшифрованными, с машинным именем рядом', async () => {
    const { svc } = makeService({ account: rows(1), project: [] });
    const controller = new PrivacyCenterController(svc as never);
    const out = await controller.decisions('u-1');
    const one = out.accountDecisions.items[0];
    expect(one.action).toBe('user.restricted');
    expect(one.what).not.toBe('user.restricted');
    expect(one.by).toBe('оператор продукта');
    // Момент, а не календарный день: день называет клиент (пункт
    // [server-said-which-day]).
    expect(one.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('нерасшифрованное действие доезжает до экрана честной оговоркой, а не догадкой', async () => {
    const { svc } = makeService({ account: rows(1, 'something.new'), project: [] });
    const controller = new PrivacyCenterController(svc as never);
    const one = (await controller.decisions('u-1')).accountDecisions.items[0];
    expect(one.what).toMatch(/не расшифровано/);
    expect(one.by).toBeNull();
    expect(one.action).toBe('something.new');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: выгрузка берёт решения тем же методом, а не своим запросом', async () => {
    // Дефект прошлого этапа — две копии одного текста, из которых
    // исправили одну. Здесь то же требование к данным, и проверяется оно
    // ПОВЕДЕНИЕМ: выгрузка зовёт `readDecisions`, а собственных запросов
    // к журналу не делает. Чтение исходника ответило бы на вопрос «стоит
    // ли вызов», а не на вопрос «пользуются ли им».
    const auditQueries: any[] = [];
    // Разрешающая заглушка: любая модель отвечает пустотой, любой метод
    // существует. Упасть выгрузке больше не на чем.
    const prisma: any = new Proxy(
      {},
      {
        get: (_t, model: string) =>
          new Proxy(
            {},
            {
              get: (_t2, method: string) => (args: any) => {
                if (model === 'auditLogEntry') auditQueries.push(args);
                if (method === 'findUnique') return Promise.resolve(null);
                if (method === 'count') return Promise.resolve(0);
                return Promise.resolve([]);
              },
            },
          ),
      },
    );
    const { PrivacyCenterService } = require('../privacy-center/privacy-center.service');
    const svc: any = Object.create(PrivacyCenterService.prototype);
    svc.prisma = prisma;

    let readDecisionsCalls = 0;
    const real = svc.readDecisions ?? PrivacyCenterService.prototype.readDecisions;
    svc.readDecisions = (userId: string) => {
      readDecisionsCalls += 1;
      return real.call(svc, userId);
    };

    const out = await svc.exportData('u-1');
    expect(readDecisionsCalls).toBe(1);
    // У разрешающей заглушки своих записей нет ни у проектов, ни у
    // прочего, поэтому запрос делает ровно одна группа — аккаунт (он
    // всегда даёт одну запись, самого человека). Важно не число само, а
    // то, что КАЖДЫЙ запрос к журналу построен реестром: `OR` из видов и
    // идентификаторов. Запрос с голым `resource` означал бы, что у
    // выгрузки снова свой.
    expect(auditQueries.length).toBe(1);
    for (const q of auditQueries) {
      expect(Array.isArray(q.where.OR)).toBe(true);
      expect(q.where.resource).toBeUndefined();
    }
    expect(out.accountDecisions).toEqual([]);
    expect(out.projectDecisions).toEqual([]);
  });
});
