// Пункт [job-search] 2026-09-01 — ядро домена кандидата: CV из слов
// кандидата (не выдумывать), вакансии по ссылкам с локальных
// джоб-сайтов (только указанный URL, SSRF-защита), AI-сверка без
// вердиктов «подходит/не подходит», детерминированная статистика.

import { BadRequestException } from '@nestjs/common';
import { JobSearchService } from '../job-search/job-search.service';

const CONFIG = {
  id: 'jsc-1',
  projectId: 'proj-js',
  desiredRole: 'Frontend-разработчик',
  city: 'Львов',
  region: 'Львовская область',
  experienceSummary: '5 лет React',
  cvText: 'CV: Frontend-разработчик, 5 лет React',
  criteria: [
    { id: 'cr-1', text: 'React', isRequired: true, orderIndex: 0 },
    { id: 'cr-2', text: 'удалёнка допустима', isRequired: false, orderIndex: 1 },
  ],
};

function makeService(opts: { vacancies?: any[] } = {}) {
  const vacancyStore: any[] = opts.vacancies ?? [];
  const prisma = {
    project: {
      findUnique: jest.fn(async () => ({ id: 'proj-js', ownerId: 'u1', mode: 'JOB_SEARCH' })),
    },
    jobSearchConfig: {
      findUnique: jest.fn(async () => ({ ...CONFIG })),
      update: jest.fn(async ({ data }: any) => ({ ...CONFIG, ...data })),
    },
    jobVacancy: {
      count: jest.fn(async () => vacancyStore.length),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `vac-${vacancyStore.length + 1}`, matchedAt: null, ...data };
        vacancyStore.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const v = vacancyStore.find((x) => x.id === where.id);
        return v ? { ...v, config: { ...CONFIG, project: { ownerId: 'u1' } } } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const v = vacancyStore.find((x) => x.id === where.id);
        Object.assign(v, data);
        return { ...v };
      }),
      findMany: jest.fn(async () => vacancyStore.map((v) => ({ ...v }))),
    },
    transcriptSegment: {
      findMany: jest.fn(async () => [{ text: 'Ищу работу фронтендером, 5 лет React, Львов' }]),
    },
  };
  const aiRouter = { execute: jest.fn() };
  return { svc: new JobSearchService(prisma as any, aiRouter as any), prisma, aiRouter, vacancyStore };
}

afterEach(() => {
  (global as any).fetch = undefined;
  jest.restoreAllMocks();
});

describe('JobSearchService', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: addVacancy скачивает ТОЛЬКО указанный URL, host нормализуется, текст обрезается — сырьё, не пересказ', async () => {
    const { svc } = makeService();
    const fetched: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, headers: { get: () => null }, text: async () => `<html>Vacancy: React dev, Львів. ${'x'.repeat(20_000)}</html>` };
    });

    const v = await svc.addVacancy('u1', 'proj-js', 'https://www.work.ua/jobs/123/');

    expect(fetched).toEqual(['https://www.work.ua/jobs/123/']); // ни кроулинга, ни соседних страниц
    expect(v.siteHost).toBe('work.ua'); // ось статистики «по сайтам», www. срезан
    expect((v.rawText as string).length).toBeLessThanOrEqual(12_000); // потолок расхода на сверку
  });

  it('matchVacancy: без CV — честный 400 («сверка идёт именно с ним»); валидный ответ пишет breakdown, выдуманные criterionId отфильтрованы', async () => {
    const { svc, prisma, aiRouter, vacancyStore } = makeService({
      vacancies: [{ id: 'vac-1', configId: 'jsc-1', siteHost: 'work.ua', rawText: 'React dev, Львів, 2000-3000$' }],
    });

    (prisma.jobSearchConfig.findUnique as jest.Mock).mockResolvedValueOnce({ ...CONFIG, cvText: null });
    // findUnique вакансии включает config — подменяем разово и его.
    (prisma.jobVacancy.findUnique as jest.Mock).mockResolvedValueOnce({
      ...vacancyStore[0],
      config: { ...CONFIG, cvText: null, project: { ownerId: 'u1' } },
    });
    await expect(svc.matchVacancy('u1', 'vac-1')).rejects.toBeInstanceOf(BadRequestException);

    aiRouter.execute.mockResolvedValue({
      text: JSON.stringify({
        title: 'React Developer',
        locationMatch: 'MATCHES',
        salaryMentioned: '2000-3000$',
        matchBreakdown: [
          { criterionId: 'cr-1', coverage: 'covered', note: 'React в требованиях' },
          { criterionId: 'fake-id', coverage: 'covered', note: 'выдумано AI' },
        ],
        notes: 'Уточните формат работы до отклика.',
      }),
      aiInferenceId: 'inf-1',
    });

    const matched = await svc.matchVacancy('u1', 'vac-1');
    expect(matched.locationMatch).toBe('MATCHES');
    expect(matched.salaryMentioned).toBe('2000-3000$');
    const breakdown = matched.matchBreakdown as Array<{ criterionId: string }>;
    expect(breakdown.map((b) => b.criterionId)).toEqual(['cr-1']); // fake-id отфильтрован
    // Никаких вердиктов в данных: только coverage + notes.
    expect(JSON.stringify(matched)).not.toMatch(/подходит|рекоменд/i);
  });

  it('getStatistics: детерминированные агрегаты по сайтам/локации/обязательным критериям, без AI-вызова', async () => {
    const { svc, aiRouter } = makeService({
      vacancies: [
        { id: 'v1', siteHost: 'work.ua', matchedAt: new Date(), locationMatch: 'MATCHES', salaryMentioned: '2000$', matchBreakdown: [{ criterionId: 'cr-1', coverage: 'covered' }] },
        { id: 'v2', siteHost: 'work.ua', matchedAt: new Date(), locationMatch: 'DIFFERENT', salaryMentioned: null, matchBreakdown: [{ criterionId: 'cr-1', coverage: 'unknown' }] },
        { id: 'v3', siteHost: 'robota.ua', matchedAt: null, locationMatch: null, salaryMentioned: null, matchBreakdown: null },
      ],
    });

    const stats = await svc.getStatistics('u1', 'proj-js');

    expect(aiRouter.execute).not.toHaveBeenCalled();
    expect(stats.total).toBe(3);
    expect(stats.matched).toBe(2);
    expect(stats.bySite).toEqual({ 'work.ua': 2, 'robota.ua': 1 });
    expect(stats.byLocationMatch).toMatchObject({ MATCHES: 1, DIFFERENT: 1, NOT_MATCHED_YET: 1 });
    expect(stats.withSalaryMentioned).toBe(1);
    expect(stats.fullRequiredCoverage).toBe(1); // только v1 закрыл обязательный cr-1
    expect(stats.city).toBe('Львов'); // регион/город кандидата — контекст статистики
  });
});
