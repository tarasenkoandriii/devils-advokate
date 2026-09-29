// Пункт [consent-that-could-not-be-given] 2026-09-24 — согласие,
// которого нельзя было дать.
//
// НАЙДЕННОЕ. ТЗ (§16.0) записывает решение владельца: «исследование
// человека — только через существующий контур `PERSON_RESEARCH`,
// отдельно». Контура не существовало: тип согласия есть в схеме, есть в
// типах клиента, есть в реестре последствий отзыва — и НЕ ТРЕБУЕТСЯ ни
// одной строкой сервера, НЕ ВЫДАЁТСЯ ни одним экраном. Всё исследование
// людей шло под общим `EXTERNAL_AI`, выданным один раз ради ответа на
// первый вопрос.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. (1) Каждый разбор из реестра действительно
// СПРАШИВАЕТ согласие — поведением, а не упоминанием: подменная служба
// согласий отказывает, и метод обязан упасть ДО обращения к модели.
// (2) Обратная сторона границы названа и не зарастает: методы уровня
// человека, зовущие модель, разложены по двум спискам без остатка.
// (3) Экран, который спрашивает согласие, существует и просит ИМЕННО
// этот тип.

import { ForbiddenException } from '@nestjs/common';
import { PERSON_RESEARCH_GATED } from '../consent/person-research';
import { createFakeConsentService } from './fake-consent';
import { PrecedentSearchService } from '../precedent-search/precedent-search.service';
import { CommunicationProfileService } from '../communication-profile/communication-profile.service';
import { MotiveAnalysisService } from '../motive-analysis/motive-analysis.service';


/** Модель, которая ОБЯЗАНА остаться нетронутой: если разбор дошёл до
 * неё, согласие не спросили. */
function forbiddenRouter() {
  return {
    called: 0,
    async execute(..._args: unknown[]) {
      (this as { called: number }).called += 1;
      throw new Error('модель вызвана, хотя согласие не выдано');
    },
  };
}

/** Пруда достаточно, чтобы метод дошёл до места, где он зовёт модель:
 * владение проверяется раньше, и отказ по владению не отличался бы от
 * отказа по согласию. */
function prismaWithPerson() {
  const person = { id: 'person-1', createdByUserId: 'user-1', displayName: 'Соседка', facts: [] };
  const project = { id: 'project-1', ownerId: 'user-1', userId: 'user-1', question: 'Вопрос' };
  return {
    person: { findFirst: async () => person, findUnique: async () => person, findUniqueOrThrow: async () => person },
    project: { findFirst: async () => project, findUnique: async () => project, findUniqueOrThrow: async () => project },
    projectPerson: { findFirst: async () => ({ projectId: project.id, personId: person.id, person }) },
    // Материал нужен НЕ для красоты: без фактов и разговоров разборы
    // честно отказываются работать раньше, чем дойдут до модели, — и
    // обратная проба ниже перестала бы что-либо значить.
    personFact: { findMany: async () => [{ id: 'f1', personId: person.id, content: 'Переносила встречу дважды', status: 'ACTIVE' }] },
    conversation: {
      findMany: async () => [
        {
          id: 'c1',
          occurredAt: new Date('2026-09-01T10:00:00Z'),
          transcript: { segments: [{ text: 'Давайте перенесём на следующую неделю' }] },
        },
      ],
      count: async () => 1,
    },
    behaviorPrecedent: { findMany: async () => [], count: async () => 0 },
    personCommunicationTrait: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    motiveHypothesis: { findMany: async () => [], count: async () => 0, createMany: async () => ({ count: 0 }) },
    promptVersion: { findFirst: async () => null, findMany: async () => [] },
    relationship: { findMany: async () => [] },
    decisionObjective: { findUnique: async () => null, findFirst: async () => null },
    projectPromptOverride: { findFirst: async () => null },
  };
}

describe('[consent-that-could-not-be-given] исследование человека спрашивает отдельное согласие', () => {
  const cases: Array<{ site: string; run: (consent: unknown, router: unknown) => Promise<unknown> }> = [
    {
      site: 'precedent-search/precedent-search.service.ts#findPrecedents',
      run: (consent, router) =>
        new PrecedentSearchService(prismaWithPerson() as any, router as any, consent as any).findPrecedents(
          'user-1',
          'person-1',
          'Ситуация, для которой ищем прецедент',
        ),
    },
    {
      site: 'communication-profile/communication-profile.service.ts#refresh',
      run: (consent, router) =>
        new CommunicationProfileService(prismaWithPerson() as any, router as any, consent as any).refresh('user-1', 'person-1'),
    },
    {
      site: 'motive-analysis/motive-analysis.service.ts#analyze',
      run: (consent, router) =>
        new MotiveAnalysisService(prismaWithPerson() as any, router as any, consent as any).analyze('user-1', 'project-1', 'person-1'),
    },
  ];

  it('КЛЮЧЕВОЙ ТЕСТ: без согласия разбор о человеке не доходит до модели', async () => {
    for (const c of cases) {
      const consent = createFakeConsentService({ granted: [] });
      const router = forbiddenRouter();
      let thrown: unknown = null;
      try {
        await c.run(consent, router);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect(router.called).toBe(0);
      const asked = consent.calls.map((x) => x.consentType);
      expect(asked).toContain('PERSON_RESEARCH');
    }
  });

  it('ОБРАТНАЯ ПРОБА: с выданным согласием тот же вызов идёт дальше — отказ был про согласие, а не про заглушку', async () => {
    for (const c of cases) {
      const consent = createFakeConsentService({ granted: true });
      const router = forbiddenRouter();
      let thrown: unknown = null;
      try {
        await c.run(consent, router);
      } catch (e) {
        thrown = e;
      }
      // Дальше разбор упирается в подменную модель, которая нарочно
      // бросает, — это и означает, что согласие пропустило.
      expect(thrown).not.toBeInstanceOf(ForbiddenException);
      if (router.called === 0) throw new Error(`${c.site}: до модели не дошло, упало на ${String(thrown)}`);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр и проверенные места совпадают', () => {
    expect(cases.map((c) => c.site).sort()).toEqual(PERSON_RESEARCH_GATED.map((g) => g.site).sort());
  });

  // Проверки, читающие ИСХОДНИКИ (разбор границы по файлам и наличие
  // экрана), вынесены в `…-registry.spec.ts`: в одном файле с
  // поведенческими они попадали бы под меру «проверок по тексту
  // исходника» целиком, включая те, что смотрят на runtime-данные.
  // Разделение — не обход меры, а то, что мера просит: держать
  // текстовые утверждения отдельно и видимо.
});
