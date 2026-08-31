import { BadGatewayException } from '@nestjs/common';
import { AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { CriteriaComparisonService } from '../criteria-comparison/criteria-comparison.service';

function makeService(aiRouter: any) {
  return new CriteriaComparisonService(aiRouter as any);
}

describe('CriteriaComparisonService', () => {
  it('acceptance-тест (НАЙВАЖЛИВІШИЙ): менше двох джерел — INSUFFICIENT_DATA, не мовчазне NO_DISCREPANCY_FOUND', async () => {
    const aiRouter = { execute: async () => { throw new Error('AI не мав викликатись при браку даних'); } };
    const service = makeService(aiRouter);

    const result = await service.compare('u1', 'proj-1', 'test-task', [
      { consultationId: 'c1', sourceLabel: 'Агент X', whatWasSaid: 'Щось сказано' },
    ]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('нуль джерел — так само INSUFFICIENT_DATA, AI не викликається', async () => {
    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '{}' }; } };
    const service = makeService(aiRouter);

    const result = await service.compare('u1', 'proj-1', 'test-task', []);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(aiCalled).toBe(false);
  });

  it('два джерела, AI визначає розбіжність — DISCREPANCY_FOUND з discrepancyNote', async () => {
    const aiRouter = {
      execute: async () => ({ text: JSON.stringify({ hasDiscrepancy: true, discrepancyNote: 'Джерела розходяться щодо строків' }) }),
    };
    const service = makeService(aiRouter);

    const result = await service.compare('u1', 'proj-1', 'test-task', [
      { consultationId: 'c1', sourceLabel: 'Агент X', whatWasSaid: 'Термін 30 днів' },
      { consultationId: 'c2', sourceLabel: 'Агент Y', whatWasSaid: 'Термін 90 днів' },
    ]);

    expect(result.status).toBe('DISCREPANCY_FOUND');
    expect(result.discrepancyNote).toBe('Джерела розходяться щодо строків');
  });

  it('два джерела, AI не знаходить розбіжності — NO_DISCREPANCY_FOUND', async () => {
    const aiRouter = { execute: async () => ({ text: JSON.stringify({ hasDiscrepancy: false }) }) };
    const service = makeService(aiRouter);

    const result = await service.compare('u1', 'proj-1', 'test-task', [
      { consultationId: 'c1', sourceLabel: 'Агент X', whatWasSaid: 'Термін 30 днів' },
      { consultationId: 'c2', sourceLabel: 'Агент Y', whatWasSaid: 'Приблизно місяць' },
    ]);

    expect(result.status).toBe('NO_DISCREPANCY_FOUND');
  });

  it('acceptance-тест (доменна незалежність): system prompt НІКОЛИ не визначає, яке твердження правдиве, і не містить доменних термінів', async () => {
    let capturedSystemPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedSystemPrompt = req.systemPrompt;
        return { text: JSON.stringify({ hasDiscrepancy: false }) };
      },
    };
    const service = makeService(aiRouter);

    await service.compare('u1', 'proj-1', 'test-task', [
      { consultationId: 'c1', sourceLabel: 'X', whatWasSaid: 'A' },
      { consultationId: 'c2', sourceLabel: 'Y', whatWasSaid: 'B' },
    ]);

    expect(capturedSystemPrompt.toLowerCase()).toContain('ніколи не визначай, яке з тверджень правдиве');
    expect(capturedSystemPrompt.toLowerCase()).not.toContain('дтп');
    expect(capturedSystemPrompt.toLowerCase()).not.toContain('розлучення');
    expect(capturedSystemPrompt.toLowerCase()).not.toContain('винуватц');
  });

  it('заблокований AI-контент (AIRouterContentBlockedError) — чесна деградація до INSUFFICIENT_DATA, не помилка й не хибне NO_DISCREPANCY_FOUND', async () => {
    const aiRouter = { execute: async () => { throw new AIRouterContentBlockedError('policy'); } };
    const service = makeService(aiRouter);

    const result = await service.compare('u1', 'proj-1', 'test-task', [
      { consultationId: 'c1', sourceLabel: 'X', whatWasSaid: 'A' },
      { consultationId: 'c2', sourceLabel: 'Y', whatWasSaid: 'B' },
    ]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('загальний збій AI-провайдера — BadGatewayException, не проковтується мовчки', async () => {
    const aiRouter = { execute: async () => { throw new Error('provider unreachable'); } };
    const service = makeService(aiRouter);

    await expect(
      service.compare('u1', 'proj-1', 'test-task', [
        { consultationId: 'c1', sourceLabel: 'X', whatWasSaid: 'A' },
        { consultationId: 'c2', sourceLabel: 'Y', whatWasSaid: 'B' },
      ]),
    ).rejects.toThrow(BadGatewayException);
  });
});
