import { WorkingMaterialsService } from '../working-materials/working-materials.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const materials: any[] = [];
  const versions: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedMaterial(m: any) { materials.push({ id: m.id ?? nextId(), createdAt: new Date(), ...m }); },
    _seedVersion(v: any) { versions.push({ id: v.id ?? nextId(), createdAt: new Date(), ...v }); },
    _getMaterials() { return materials; },
    _getVersions() { return versions; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    workingMaterial: {
      findFirst: async ({ where, include }: any) => {
        const m = materials.find((x) => x.id === where.id && x.projectId === where.projectId);
        if (!m) return null;
        if (include?.versions) return { ...m, versions: versions.filter((v) => v.workingMaterialId === m.id).sort((a, b) => a.versionNumber - b.versionNumber) };
        return m;
      },
      findMany: async ({ where, include }: any) => {
        let result = materials.filter((m) => m.projectId === where.projectId);
        if (include?.versions) {
          result = result.map((m) => ({ ...m, versions: versions.filter((v) => v.workingMaterialId === m.id).sort((a, b) => a.versionNumber - b.versionNumber) }));
        }
        return [...result].sort((a, b) => b.createdAt - a.createdAt);
      },
      create: async ({ data }: any) => {
        const m = { id: nextId(), createdAt: new Date(), ...data };
        materials.push(m);
        return m;
      },
    },
    materialVersion: {
      findFirst: async ({ where, orderBy }: any) => {
        const list = versions.filter((v) => v.workingMaterialId === where.workingMaterialId);
        if (list.length === 0) return null;
        return [...list].sort((a, b) => (orderBy.versionNumber === 'desc' ? b.versionNumber - a.versionNumber : a.versionNumber - b.versionNumber))[0];
      },
      create: async ({ data }: any) => {
        const v = { id: nextId(), createdAt: new Date(), ...data };
        versions.push(v);
        return v;
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '{"critique":"x","editPrompt":"y"}';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>, goal: string | null = null) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Встреча с инвестором', goal });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('submitVersion() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.submitVersion(USER_ID, PROJECT_ID, 'текст', undefined, 'Заголовок'),
      NotFoundException,
      'submitVersion() на чужой проект',
    );
  });

  test('submitVersion() бросает BadRequestException для пустого extractedText', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.submitVersion(USER_ID, PROJECT_ID, '   ', undefined, 'Заголовок'),
      BadRequestException,
      'submitVersion() с пустым extractedText',
    );
  });

  test('submitVersion() бросает BadRequestException, если создаётся новый материал без title', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.submitVersion(USER_ID, PROJECT_ID, 'текст'),
      BadRequestException,
      'submitVersion() без title для нового материала',
    );
  });

  test('submitVersion() без materialId создаёт новый материал с версией 1', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);

    const { material, version } = await svc.submitVersion(USER_ID, PROJECT_ID, 'Текст ТЗ', undefined, 'ТЗ для инвестора');
    assertEqual(material.title, 'ТЗ для инвестора', 'заголовок сохранён');
    assertEqual(version.versionNumber, 1, 'первая версия');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: submitVersion() с materialId увеличивает номер версии автоматически', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);

    const first = await svc.submitVersion(USER_ID, PROJECT_ID, 'v1 текст', undefined, 'Материал');
    const second = await svc.submitVersion(USER_ID, PROJECT_ID, 'v2 текст, исправлено', first.material.id);
    const third = await svc.submitVersion(USER_ID, PROJECT_ID, 'v3 текст, снова исправлено', first.material.id);

    assertEqual(second.version.versionNumber, 2, 'вторая версия автоматически = 2');
    assertEqual(third.version.versionNumber, 3, 'третья версия автоматически = 3');
    assertEqual(second.material.id, first.material.id, 'та же запись материала, не новая');
  });

  test('submitVersion() бросает NotFoundException для materialId не из этого проекта', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProject({ id: 'other-proj', ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedMaterial({ id: 'mat-other', projectId: 'other-proj', title: 'x' });
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.submitVersion(USER_ID, PROJECT_ID, 'текст', 'mat-other'),
      NotFoundException,
      'submitVersion() с materialId из другого проекта',
    );
  });

  test('submitVersion() подмешивает Project.goal в промпт, если он указан', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Убедить инвестора вложиться на выгодных условиях');
    const fakeRouter = new FakeAIRouterService();
    const svc = new WorkingMaterialsService(prisma as any, fakeRouter as any);

    await svc.submitVersion(USER_ID, PROJECT_ID, 'текст материала', undefined, 'Материал');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Убедить инвестора вложиться на выгодных условиях'), true, 'цель проекта попала в промпт');
  });

  test('submitVersion() честно указывает отсутствие цели, не выдумывает её', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, null);
    const fakeRouter = new FakeAIRouterService();
    const svc = new WorkingMaterialsService(prisma as any, fakeRouter as any);

    await svc.submitVersion(USER_ID, PROJECT_ID, 'текст материала', undefined, 'Материал');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('пока не указана'), true, 'честное указание отсутствия цели');
  });

  test('submitVersion() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new WorkingMaterialsService(prisma as any, failingRouter as any);
    await assertThrowsAsync(
      () => svc.submitVersion(USER_ID, PROJECT_ID, 'текст', undefined, 'Материал'),
      BadGatewayException,
      'submitVersion() при недоступности провайдера',
    );
  });

  test('getMaterial() возвращает материал со всеми версиями по порядку', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    const first = await svc.submitVersion(USER_ID, PROJECT_ID, 'v1', undefined, 'Материал');
    await svc.submitVersion(USER_ID, PROJECT_ID, 'v2', first.material.id);

    const full = await svc.getMaterial(USER_ID, PROJECT_ID, first.material.id);
    assertEqual(full.versions.length, 2, 'обе версии видны — лог итераций');
    assertEqual(full.versions[0].versionNumber, 1, 'первая версия идёт первой');
    assertEqual(full.versions[1].versionNumber, 2, 'вторая версия идёт следом');
  });

  test('getMaterial() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.getMaterial(USER_ID, PROJECT_ID, 'any-id'), NotFoundException, 'getMaterial() на чужой проект');
  });

  test('listMaterials() возвращает материалы проекта с версиями', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new WorkingMaterialsService(prisma as any, new FakeAIRouterService() as any);
    await svc.submitVersion(USER_ID, PROJECT_ID, 'текст', undefined, 'Материал 1');

    const list = await svc.listMaterials(USER_ID, PROJECT_ID);
    assertEqual(list.length, 1, 'материал виден');
    assertEqual(list[0].versions.length, 1, 'версия включена в ответ');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nWorkingMaterialsService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});
