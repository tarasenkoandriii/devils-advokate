import { EvaluationService } from '../evaluation/evaluation.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const users = new Map<string, any>();
  const promptVersions = new Map<string, any>();
  const datasets = new Map<string, any>();
  const cases: any[] = [];
  const runs: any[] = [];
  const caseResults: any[] = [];
  const results: any[] = [];
  const metrics = new Map<string, any>();
  const gates: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedUser(u: any) { users.set(u.id, { isOperator: false, ...u }); },
    _seedPromptVersion(v: any) { promptVersions.set(v.id, v); },
    _getCaseResults() { return caseResults; },
    _getResults() { return results; },
    _getGates() { return gates; },
    _getMetricName(metricId: string) {
      for (const [name, m] of metrics) {
        if (m.id === metricId) return name;
      }
      return undefined;
    },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    promptVersion: {
      findUnique: async ({ where }: any) => promptVersions.get(where.id) ?? null,
    },
    evaluationDataset: {
      create: async ({ data }: any) => {
        const d = { id: nextId(), createdAt: new Date(), ...data };
        datasets.set(d.id, d);
        return d;
      },
      findUnique: async ({ where, include }: any) => {
        const d = datasets.get(where.id);
        if (!d) return null;
        if (include?.cases) {
          return { ...d, cases: cases.filter((c) => c.evaluationDatasetId === d.id) };
        }
        return d;
      },
    },
    evaluationCase: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), ...data };
        cases.push(c);
        return c;
      },
    },
    evaluationRun: {
      create: async ({ data }: any) => {
        const r = { id: nextId(), startedAt: new Date(), completedAt: null, ...data };
        runs.push(r);
        return r;
      },
      update: async ({ where, data }: any) => {
        const idx = runs.findIndex((r) => r.id === where.id);
        runs[idx] = { ...runs[idx], ...data };
        return runs[idx];
      },
      findUnique: async ({ where }: any) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) return null;
        return {
          ...r,
          results: results.filter((res) => res.evaluationRunId === r.id).map((res) => ({
            ...res,
            evaluationMetric: metrics.get(res.evaluationMetricId),
          })),
          caseResults: caseResults.filter((cr) => cr.evaluationRunId === r.id),
          releaseGate: gates.find((g) => g.evaluationRunId === r.id) ?? null,
        };
      },
    },
    evaluationCaseResult: {
      create: async ({ data }: any) => {
        const cr = { id: nextId(), createdAt: new Date(), ...data };
        caseResults.push(cr);
        return cr;
      },
    },
    evaluationResult: {
      create: async ({ data }: any) => {
        const r = { id: nextId(), createdAt: new Date(), ...data };
        results.push(r);
        return r;
      },
    },
    evaluationMetric: {
      findUnique: async ({ where }: any) => metrics.get(where.name) ?? null,
      create: async ({ data }: any) => {
        const m = { id: nextId(), ...data };
        metrics.set(m.name, m);
        return m;
      },
    },
    releaseGate: {
      create: async ({ data }: any) => {
        const g = { id: nextId(), decidedAt: new Date(), ...data };
        gates.push(g);
        return g;
      },
    },
  };
}

function makeService(prisma: any, aiRouter: any) {
  return new EvaluationService(prisma, aiRouter);
}

describe('EvaluationService', () => {
  it('отклоняет операции для пользователя без isOperator', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', isOperator: false });
    const service = makeService(prisma, {} as any);

    await expect(service.createDataset('u1', 'ds', 'v1')).rejects.toThrow(ForbiddenException);
  });

  it('отклоняет evaluate для датасета с менее чем 40 classification-кейсов (ТЗ §4.1)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'discrepancy-detector', template: 'sys' });
    const service = makeService(prisma, {} as any);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    await service.addCases('op1', dataset.id, [
      { input: 'case 1', expectedOutput: { label: 'none' }, caseType: 'classification' },
    ]);

    await expect(service.evaluate('op1', 'pv1', dataset.id)).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §6.2: false_positive_rate для strong_discrepancy считается точно, gate не проходит при превышении порога', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'discrepancy-detector', template: 'sys' });

    // AI "ошибается" на 3 из 40 кейсов — говорит strong_discrepancy там,
    // где expectedLabel = none (ложное срабатывание).
    let callCount = 0;
    const fakeAiRouter = {
      execute: async () => {
        callCount++;
        const isFalsePositiveCase = callCount <= 3;
        return { text: JSON.stringify({ label: isFalsePositiveCase ? 'strong_discrepancy' : 'none' }) };
      },
    };
    const service = makeService(prisma, fakeAiRouter);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    const caseInputs = Array.from({ length: 40 }, (_, i) => ({
      input: `case ${i}`,
      expectedOutput: { label: 'none' }, // ни один кейс на самом деле НЕ strong_discrepancy
      caseType: 'classification' as const,
    }));
    await service.addCases('op1', dataset.id, caseInputs);

    const run = await service.evaluate('op1', 'pv1', dataset.id);

    const fprResult = prisma._getResults().find((r: any) => r.evaluationMetricId && prisma._getMetricName(r.evaluationMetricId) === 'false_positive_rate');
    expect(fprResult).toBeDefined();
    // 3 ложных срабатывания из 40 кейсов = 0.075 > порог 0.05
    expect(fprResult.value).toBeCloseTo(3 / 40, 5);
    expect(fprResult.passed).toBe(false);

    const gate = prisma._getGates().find((g: any) => g.evaluationRunId === run.id);
    expect(gate.passed).toBe(false);
  });

  it('acceptance-тест §6.3: alternative_explanation_completeness считается точно, note указывает на конкретную гипотезу', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'motive-analysis', template: 'sys' });

    // 10 сценариев, каждый генерирует 2 гипотезы (20 всего), у одной
    // гипотезы alternativeExplanation пустой — как в тексте ТЗ §6.3.
    let callCount = 0;
    const fakeAiRouter = {
      execute: async () => {
        callCount++;
        const missingOnFirstCase = callCount === 1;
        return {
          text: JSON.stringify([
            { explanation: 'h1', alternativeExplanation: missingOnFirstCase ? '' : 'alt1' },
            { explanation: 'h2', alternativeExplanation: 'alt2' },
          ]),
        };
      },
    };
    const service = makeService(prisma, fakeAiRouter);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    const caseInputs = Array.from({ length: 10 }, (_, i) => ({
      input: `scenario ${i}`,
      caseType: 'structural' as const,
    }));
    await service.addCases('op1', dataset.id, caseInputs);

    const run = await service.evaluate('op1', 'pv1', dataset.id);

    const metricResult = prisma._getResults().find((r: any) => prisma._getMetricName(r.evaluationMetricId) === 'alternative_explanation_completeness');
    expect(metricResult.value).toBeCloseTo(19 / 20, 5);
    expect(metricResult.passed).toBe(false); // порог 100%, буквально

    const failedCaseResult = prisma._getCaseResults().find((cr: any) => !cr.passed);
    expect(failedCaseResult.note).toContain('missing alternativeExplanation');

    const gate = prisma._getGates().find((g: any) => g.evaluationRunId === run.id);
    expect(gate.passed).toBe(false);
  });

  it('структурный gate проходит, когда у всех гипотез есть alternativeExplanation', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'motive-analysis', template: 'sys' });

    const fakeAiRouter = {
      execute: async () => ({
        text: JSON.stringify([{ explanation: 'h1', alternativeExplanation: 'alt1' }]),
      }),
    };
    const service = makeService(prisma, fakeAiRouter);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    await service.addCases('op1', dataset.id, [{ input: 'scenario', caseType: 'structural' as const }]);

    const run = await service.evaluate('op1', 'pv1', dataset.id);
    const gate = prisma._getGates().find((g: any) => g.evaluationRunId === run.id);
    expect(gate.passed).toBe(true);
  });

  it('честно засчитывает провал кейса, если AI-вызов упал или вернул невалидный JSON', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'motive-analysis', template: 'sys' });

    const fakeAiRouter = { execute: async () => { throw new Error('AI provider timeout'); } };
    const service = makeService(prisma, fakeAiRouter);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    await service.addCases('op1', dataset.id, [{ input: 'scenario', caseType: 'structural' as const }]);

    await service.evaluate('op1', 'pv1', dataset.id);
    const caseResult = prisma._getCaseResults()[0];
    expect(caseResult.passed).toBe(false);
    expect(caseResult.actualOutput).toContain('AI call failed');
  });

  it('getRun возвращает failedCases отдельным списком', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'motive-analysis', template: 'sys' });

    const fakeAiRouter = { execute: async () => ({ text: JSON.stringify([{ explanation: 'h', alternativeExplanation: '' }]) }) };
    const service = makeService(prisma, fakeAiRouter);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    await service.addCases('op1', dataset.id, [{ input: 'scenario', caseType: 'structural' as const }]);
    const run = await service.evaluate('op1', 'pv1', dataset.id);

    const fetched = await service.getRun('op1', run.id);
    expect(fetched.failedCases.length).toBe(1);
  });

  it('отклоняет evaluate, если датасет пуст', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedPromptVersion({ id: 'pv1', promptId: 'x', template: 'sys' });
    const service = makeService(prisma, {} as any);

    const dataset = await service.createDataset('op1', 'ds', 'v1');
    await expect(service.evaluate('op1', 'pv1', dataset.id)).rejects.toThrow(BadRequestException);
  });

  it('getRun с несуществующим id даёт NotFoundException', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma, {} as any);

    await expect(service.getRun('op1', 'nonexistent')).rejects.toThrow(NotFoundException);
  });
});
