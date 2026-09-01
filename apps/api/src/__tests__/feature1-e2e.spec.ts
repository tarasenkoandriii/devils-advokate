// Сквозной тест фичи 1 целиком — не изолированные юниты, а весь путь
// одного запроса пользователя: создать проект (ProjectsService) → дать
// согласие (ConsentService) → сгенерировать аргументы через реальный
// AIRouterService (с ContentScanService внутри) → прочитать историю
// проекта обратно (ProjectsService.getDetail, фича 2) и убедиться, что
// созданные Argument-записи там есть с правильным derivedFromInferenceId.
//
// Единая fake-Prisma на все сервисы сразу — тест ловит именно те баги,
// которые не видны в изолированных unit-тестах (например то, что
// getDetail() и generate() должны видеть одни и те же записи).

import { ProjectsService } from '../projects/projects.service';
import { ConsentService } from '../consent/consent.service';
import { ContentScanService } from '../content-scan/content-scan.service';
import { AIRouterService } from '../ai-router/ai-router.service';
import { ArgumentGenerationService } from '../arguments/argument-generation.service';

function createSharedFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsStore = new Map<string, any>();
  const aiJobs = new Map<string, any>();
  const aiModelVersions = new Map<string, any>();
  const aiModelCapabilities: any[] = [];
  const aiInferences = new Map<string, any>();
  const consentRecords: any[] = [];
  const contentScanResults = new Map<string, any>();
  const contentScanDetections: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedModelVersion(mv: any) { aiModelVersions.set(mv.id, mv); },
    _seedCapability(cap: any) { aiModelCapabilities.push(cap); },

    project: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        projects.set(p.id, p);
        return p;
      },
      findFirst: async ({ where, include }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        if (include?.arguments) {
          return {
            ...p,
            arguments: [...argumentsStore.values()]
              .filter((a) => a.projectId === p.id)
              .sort((a, b) => a.createdAt - b.createdAt),
            people: [],
          };
        }
        return p;
      },
      findMany: async () => [],
      count: async () => 0,
    },
    argument: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        argumentsStore.set(a.id, a);
        return a;
      },
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),

    aIJob: {
      findFirst: async () => null, // [idempotency]: переиспользование в этих тестах не предмет проверки
      count: async () => 0, // [rate-limits]: суточный потолок — в этих тестах не предмет проверки
      create: async ({ data }: any) => { const job = { id: nextId(), retryCount: 0, ...data }; aiJobs.set(job.id, job); return job; },
      update: async ({ where, data }: any) => {
        const job = aiJobs.get(where.id);
        const merged = { ...job, ...data };
        if (data.retryCount?.increment) merged.retryCount = (job.retryCount ?? 0) + data.retryCount.increment;
        aiJobs.set(where.id, merged);
        return merged;
      },
      findUniqueOrThrow: async ({ where }: any) => { const job = aiJobs.get(where.id); if (!job) throw new Error('job not found'); return job; },
    },
    aIModelVersion: { findUnique: async ({ where }: any) => aiModelVersions.get(where.id) ?? null },
    aIModelCapability: {
      findFirst: async ({ where }: any) => {
        const cap = aiModelCapabilities.find((c) => c.taskType === where.taskType && c.availability === where.availability);
        if (!cap) return null;
        return { ...cap, modelVersion: aiModelVersions.get(cap.modelVersionId) };
      },
    },
    aIInference: {
      create: async ({ data }: any) => { const inf = { id: nextId(), ...data }; aiInferences.set(inf.id, inf); return inf; },
    },
    consentRecord: {
      findFirst: async ({ where }: any) =>
        consentRecords.find(
          (c) => c.userId === where.userId && c.consentType === where.consentType && c.granted === true && c.revokedAt === null,
        ) ?? null,
      create: async ({ data }: any) => {
        const record = { id: nextId(), revokedAt: null, projectId: null, purposes: [], ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
        consentRecords.push(record);
        return record;
      },
    },
    contentScanResult: {
      create: async ({ data }: any) => { const r = { id: nextId(), ...data }; contentScanResults.set(r.id, r); return r; },
      updateMany: async ({ where, data }: any) => { const r = contentScanResults.get(where.id); if (r) contentScanResults.set(where.id, { ...r, ...data }); return { count: r ? 1 : 0 }; },
    },
    contentScanDetection: { create: async ({ data }: any) => { const d = { id: nextId(), ...data }; contentScanDetections.push(d); return d; } },
    promptVersion: {
      findFirst: async () => null,
    },
    // Найдено аудитом: ArgumentGenerationService.generate() обращается
    // к decisionObjective.findUnique() (проверяет, есть ли уже
    // сохранённая цель разговора, чтобы подмешать в промпт) — этой
    // модели не было в фейке вообще, тест падал с "Cannot read
    // properties of undefined (reading 'findUnique')" ещё до того, как
    // добраться до собственно проверяемой логики. В этом e2e-сценарии
    // цель никогда не сохраняется, поэтому null — корректное поведение
    // "проекта без DecisionObjective", не заглушка, отменяющая суть теста.
    decisionObjective: {
      findUnique: async () => null,
    },
  };
}

function fakeSecrets(map: Record<string, string>) {
  return { resolve: async (ref: string) => map[ref] ?? 'fake-key' };
}

function mockFetchOnce(body: any) {
  (global as any).fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const openaiSuccessBody = {
  choices: [
    {
      message: {
        content: JSON.stringify([
          { text: 'Стабильный доход важен для планирования', stance: 'con', weight: 0.6 },
          { text: 'Рынок труда сейчас в вашу пользу', stance: 'pro', weight: 0.8 },
        ]),
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
};

describe('Фича 1 — сквозной путь: проект → согласие → генерация → история', () => {
  it('полный цикл создаёт аргументы и они видны через getDetail()', async () => {
    const prisma = createSharedFakePrisma();

    prisma._seedModelVersion({
      id: 'mv-openai',
      version: 'gpt-4.1',
      model: { name: 'gpt-4.1', provider: { name: 'openai', apiEndpoint: 'https://api.openai.com/v1', credentialRef: 'OPENAI_API_KEY' } },
    });
    prisma._seedCapability({ modelVersionId: 'mv-openai', taskType: 'argument-generation', availability: 'active' });
    mockFetchOnce(openaiSuccessBody);

    const projectsService = new ProjectsService(prisma as any);
    const consentService = new ConsentService(prisma as any);
    const contentScanService = new ContentScanService(prisma as any);
    const aiRouter = new AIRouterService(prisma as any, fakeSecrets({ OPENAI_API_KEY: 'sk-test' }) as any, consentService, contentScanService, { resolve: async () => ({ uri: 'https://resolved.example/x' }) } as any);
    const argumentGenService = new ArgumentGenerationService(prisma as any, aiRouter);

    const USER_ID = 'user-1';

    const project = await projectsService.create(USER_ID, {
      question: 'Стоит ли просить о повышении зарплаты в этом квартале',
      goal: 'Повышение на 20%',
    });

    await consentService.grant({
      userId: USER_ID,
      consentType: 'EXTERNAL_AI' as any,
      version: 'v1',
      source: 'test',
    });

    const generated = await argumentGenService.generate(project.id, USER_ID);
    expect(generated.length).toBe(2);
    expect(generated.every((a) => a.derivedFromInferenceId)).toBe(true);
    expect(generated.some((a) => a.stance === 'PRO')).toBe(true);
    expect(generated.some((a) => a.stance === 'CON')).toBe(true);

    const detail = await projectsService.getDetail(USER_ID, project.id);
    expect(detail.arguments.length).toBe(2);
    expect(detail.arguments.map((a: any) => a.id).sort()).toEqual(generated.map((a) => a.id).sort());
  });

  it('чужой пользователь не видит проект даже после генерации аргументов', async () => {
    const prisma = createSharedFakePrisma();
    prisma._seedModelVersion({
      id: 'mv-openai',
      version: 'gpt-4.1',
      model: { name: 'gpt-4.1', provider: { name: 'openai', apiEndpoint: 'https://api.openai.com/v1', credentialRef: 'OPENAI_API_KEY' } },
    });
    prisma._seedCapability({ modelVersionId: 'mv-openai', taskType: 'argument-generation', availability: 'active' });
    mockFetchOnce(openaiSuccessBody);

    const projectsService = new ProjectsService(prisma as any);
    const consentService = new ConsentService(prisma as any);
    const contentScanService = new ContentScanService(prisma as any);
    const aiRouter = new AIRouterService(prisma as any, fakeSecrets({ OPENAI_API_KEY: 'sk-test' }) as any, consentService, contentScanService, { resolve: async () => ({ uri: 'https://resolved.example/x' }) } as any);
    const argumentGenService = new ArgumentGenerationService(prisma as any, aiRouter);

    const project = await projectsService.create('owner', { question: 'Q' });
    await consentService.grant({ userId: 'owner', consentType: 'EXTERNAL_AI' as any, version: 'v1', source: 'test' });
    await argumentGenService.generate(project.id, 'owner');

    await expect(projectsService.getDetail('intruder', project.id)).rejects.toThrow();
    await expect(argumentGenService.generate(project.id, 'intruder')).rejects.toThrow();
  });
});
