import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MajorPurchaseService } from '../major-purchase/major-purchase.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const variants = new Map<string, any>();
  const meetings = new Map<string, any>();
  const comparisons: any[] = [];
  const conversations = new Map<string, any>();
  const signals: any[] = [];
  const criteria: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  function variantWithConfig(id: string) {
    const v = variants.get(id);
    if (!v) return null;
    const config = configs.get(v.configId);
    return { ...v, config: { ...config, project: projects.get(config.projectId) } };
  }

  return {
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedConfig(c: any) {
      const config = { id: nextId(), ...c };
      configs.set(config.id, config);
      return config;
    },
    _seedVariant(v: any) {
      const variant = { id: nextId(), askingPrice: null, currency: null, placeId: null, placeName: null, placeAddress: null, latitude: null, longitude: null, createdAt: new Date(), ...v };
      variants.set(variant.id, variant);
      return variant;
    },
    _seedMeeting(m: any) {
      const meeting = { id: nextId(), conclusionDraft: null, conclusionFinal: null, draftedAt: null, reviewedAt: null, criteriaBreakdown: null, ...m };
      meetings.set(meeting.id, meeting);
      return meeting;
    },
    _seedConversation(c: any) {
      const conv = { id: nextId(), ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _seedSignal(s: any) {
      signals.push(s);
    },
    _getComparisons() {
      return comparisons;
    },
    _seedCriterion(c: any) {
      criteria.push({ id: nextId(), ...c });
      return criteria[criteria.length - 1];
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    majorPurchaseConfig: {
      findUnique: async ({ where, include }: any) => {
        const config = where.id ? configs.get(where.id) : [...configs.values()].find((c) => c.projectId === where.projectId);
        if (!config) return null;
        if (include?.project) return { ...config, project: projects.get(config.projectId) };
        if (include?.criteria) {
          const rows = criteria.filter((c) => c.configId === config.id).sort((a, b) => a.orderIndex - b.orderIndex);
          return { ...config, criteria: rows };
        }
        return config;
      },
      create: async ({ data, include }: any) => {
        const { criteria: criteriaInput, ...rest } = data;
        const config = { id: nextId(), ...rest };
        configs.set(config.id, config);
        const createdCriteria = (criteriaInput?.create ?? []).map((c: any) => ({ id: nextId(), configId: config.id, ...c }));
        createdCriteria.forEach((c: any) => criteria.push(c));
        return include?.criteria ? { ...config, criteria: createdCriteria } : config;
      },
    },
    purchaseVariant: {
      create: async ({ data }: any) => {
        const variant = { id: nextId(), askingPrice: null, currency: null, placeId: null, placeName: null, placeAddress: null, latitude: null, longitude: null, ...data };
        variants.set(variant.id, variant);
        return variant;
      },
      findUnique: async ({ where, include }: any) => {
        if (include?.config) return variantWithConfig(where.id);
        const v = variants.get(where.id) ?? null;
        if (!v) return null;
        if (include?.meetings || include?.comparisons) {
          return {
            ...v,
            meetings: [...meetings.values()].filter((m) => m.variantId === v.id).sort((a, b) => b.occurredAt - a.occurredAt),
            comparisons: comparisons.filter((c) => c.variantId === v.id).sort((a, b) => b.createdAt - a.createdAt),
          };
        }
        return v;
      },
      findMany: async ({ where, include, orderBy }: any) => {
        let rows = [...variants.values()].filter((v) => v.configId === where.configId);
        if (orderBy?.createdAt) rows = rows.sort((a, b) => a.createdAt - b.createdAt);
        if (include?.meetings || include?.comparisons) {
          rows = rows.map((v) => ({
            ...v,
            meetings: [...meetings.values()].filter((m) => m.variantId === v.id).sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 1),
            comparisons: comparisons.filter((c) => c.variantId === v.id),
          }));
        }
        return rows;
      },
      update: async ({ where, data }: any) => {
        const v = variants.get(where.id);
        Object.assign(v, data);
        return v;
      },
    },
    purchaseMeeting: {
      create: async ({ data }: any) => {
        const meeting = { id: nextId(), conclusionDraft: null, conclusionFinal: null, draftedAt: null, reviewedAt: null, ...data };
        meetings.set(meeting.id, meeting);
        return meeting;
      },
      findUnique: async ({ where, include }: any) => {
        const m = meetings.get(where.id);
        if (!m) return null;
        if (include?.variant) {
          const v = variantWithConfig(m.variantId);
          return { ...m, variant: v };
        }
        return m;
      },
      update: async ({ where, data }: any) => {
        const m = meetings.get(where.id);
        Object.assign(m, data);
        return m;
      },
    },
    marketComparison: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), ...data };
        comparisons.push(c);
        return c;
      },
      findMany: async ({ where }: any) => comparisons.filter((c) => c.variantId === where.variantId),
    },
    conversation: {
      findUnique: async ({ where, include }: any) => {
        const conv = conversations.get(where.id);
        if (!conv) return null;
        if (include?.project) return { ...conv, project: projects.get(conv.projectId) };
        return conv;
      },
    },
    conversationSignal: {
      findMany: async () => signals,
    },
    quizCriterion: {
      findMany: async ({ where, orderBy }: any) => {
        let rows = criteria.filter((c) => c.configId === where.configId);
        if (orderBy?.orderIndex) rows = rows.sort((a, b) => a.orderIndex - b.orderIndex);
        return rows;
      },
    },
  };
}

function makeService(
  prisma: any,
  overrides: { aiRouter?: any; consent?: any; secrets?: any } = {},
) {
  const aiRouter = overrides.aiRouter ?? { execute: async () => ({ text: '{}' }) };
  const consent = overrides.consent ?? { requireConsent: async () => {}, grant: async (input: any) => ({ id: 'consent-1', ...input }) };
  const secrets = overrides.secrets ?? { resolve: async () => 'fake-api-key' };
  return new MajorPurchaseService(prisma as any, aiRouter as any, consent as any, secrets as any);
}

describe('MajorPurchaseService', () => {
  it('createConfig фіксує чернетку з критеріями, відхиляє повторне створення для того самого проєкту', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);

    const config = await service.createConfig('u1', project.id, 'REAL_ESTATE' as any, {
      goalDescription: 'Квартира в Києві',
      budgetMin: 50000,
      budgetMax: 100000,
      currency: 'USD',
      financingMethod: null,
      timeline: null,
      criteria: [{ text: '2 спальні', isRequired: true, orderIndex: 0 }],
    });

    expect(config.criteria.length).toBe(1);

    await expect(
      service.createConfig('u1', project.id, 'REAL_ESTATE' as any, {
        goalDescription: 'дубль',
        budgetMin: null,
        budgetMax: null,
        currency: null,
        financingMethod: null,
        timeline: null,
        criteria: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('setLocationByPlaceId НЕ вимагає ConsentType.LOCATION — ручний ввід', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });

    let consentChecked = false;
    const consent = { requireConsent: async () => { consentChecked = true; }, grant: async () => ({}) };
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'OK', result: { name: 'ЖК Комфорт Таун', formatted_address: 'вул. Регенераторна, Київ', geometry: { location: { lat: 50.43, lng: 30.6 } } } }),
    }));
    const service = makeService(prisma, { consent });

    const updated = await service.setLocationByPlaceId('u1', variant.id, 'place-123');

    expect(consentChecked).toBe(false);
    expect(updated.placeId).toBe('place-123');
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §7 ТЗ: setLocationByGeolocation вимагає ConsentType.LOCATION, без нього — ForbiddenException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'VEHICLE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Toyota Camry' });

    const consent = {
      requireConsent: async () => { throw new ForbiddenException('Consent required: LOCATION'); },
      grant: async () => ({}),
    };
    const service = makeService(prisma, { consent });

    await expect(service.setLocationByGeolocation('u1', variant.id, 50.45, 30.52)).rejects.toThrow(ForbiddenException);
  });

  it('setLocationByGeolocation обирає placeType за категорією варіанту (car_dealer для VEHICLE)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'VEHICLE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Camry' });

    let capturedPlaceType = '';
    let capturedRankBy = '';
    let capturedRadius: string | null = 'not-checked';
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('nearbysearch')) {
        const parsed = new URL(url);
        capturedPlaceType = parsed.searchParams.get('type') ?? '';
        capturedRankBy = parsed.searchParams.get('rankby') ?? '';
        capturedRadius = parsed.searchParams.get('radius');
        return { ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };
      }
      return { ok: true, json: async () => ({ status: 'OK', result: {} }) };
    });
    const service = makeService(prisma);

    await service.setLocationByGeolocation('u1', variant.id, 50.45, 30.52);

    expect(capturedPlaceType).toBe('car_dealer');
    // Регресійний тест на реальний баг, знайдений аудитом: раніше
    // використовувався searchNearbyVenues() з radius (сортування за
    // популярністю, не за відстанню) — виправлено на
    // searchNearestByDistance() з rankby=distance.
    expect(capturedRankBy).toBe('distance');
    expect(capturedRadius).toBeNull();
    (global as any).fetch = undefined;
  });

  it('регресійний тест: candidates[0] від searchNearestByDistance дійсно найближче місце, не найпопулярніше — rankby=distance гарантує сортування Google за відстанню', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });

    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('nearbysearch')) {
        // Google повертає результати ВЖЕ впорядкованими за відстанню
        // при rankby=distance — перший елемент дійсно найближчий.
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            results: [
              { place_id: 'nearest-agency', name: 'Маленьке агентство поруч', rating: 3.2 },
              { place_id: 'popular-agency', name: 'Популярне агентство далі', rating: 4.9 },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ status: 'OK', result: { name: 'Маленьке агентство поруч', formatted_address: 'вул. Тестова, 1' } }),
      };
    });
    const service = makeService(prisma);

    const updated = await service.setLocationByGeolocation('u1', variant.id, 50.45, 30.52);

    expect(updated.placeId).toBe('nearest-agency');
    (global as any).fetch = undefined;
  });

  it('grantLocationConsent записує purposes=["major_purchase_viewings"]', async () => {
    const prisma = createFakePrisma();
    let capturedPurposes: string[] = [];
    const consent = {
      requireConsent: async () => {},
      grant: async (input: any) => { capturedPurposes = input.purposes; return { id: 'c1', ...input }; },
    };
    const service = makeService(prisma, { consent });

    await service.grantLocationConsent('u1', 'v1');

    expect(capturedPurposes).toEqual(['major_purchase_viewings']);
  });

  it('acceptance-тест §7 ТЗ: addComparison завантажує ЛИШЕ вказаний URL, не сканує маркетплейс сам', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });

    const fetchedUrls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      fetchedUrls.push(url);
      return { ok: true, headers: { get: () => null }, text: async () => '<html>Цена: $95000</html>' };
    });
    const aiRouter = { execute: async () => ({ text: JSON.stringify({ extractedPrice: 95000 }) }) };
    const service = makeService(prisma, { aiRouter });

    const comparison = await service.addComparison('u1', variant.id, 'https://example.com/listing/1');

    expect(fetchedUrls).toEqual(['https://example.com/listing/1']);
    expect(comparison.extractedPrice).toBe(95000);
    (global as any).fetch = undefined;
  });

  it('addComparison чесно деградує до null, коли AI не може виділити ціну', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });

    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => '<html>без ціни</html>',
    }));
    const aiRouter = { execute: async () => ({ text: JSON.stringify({ extractedPrice: null }) }) };
    const service = makeService(prisma, { aiRouter });

    const comparison = await service.addComparison('u1', variant.id, 'https://example.com/listing/2');

    expect(comparison.extractedPrice).toBeNull();
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §7 ТЗ: conclusionFinal лишається null, поки reviewConclusion не викликаний явно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1', currency: 'USD' });
    const conv = prisma._seedConversation({ ownerId: 'u1', projectId: project.id, project: { ownerId: 'u1' } });
    const meeting = prisma._seedMeeting({ variantId: variant.id, conversationId: conv.id, occurredAt: new Date() });

    const aiRouter = {
      execute: async () => ({
        text: JSON.stringify({
          conclusion: 'Варто уточнити стан труб.',
          criteriaBreakdown: [{ criterionId: 'crit-1', covered: 'partial', note: 'Про труби нічого не сказали' }],
        }),
      }),
    };
    const service = makeService(prisma, { aiRouter });

    const afterDraft = await service.generateConclusion('u1', meeting.id);
    expect(afterDraft.conclusionDraft).toBe('Варто уточнити стан труб.');
    expect(afterDraft.conclusionFinal).toBeNull();
    expect(afterDraft.criteriaBreakdown).toEqual([{ criterionId: 'crit-1', covered: 'partial', note: 'Про труби нічого не сказали' }]);

    const afterReview = await service.reviewConclusion('u1', meeting.id, 'Фінальний висновок користувача');
    expect(afterReview.conclusionFinal).toBe('Фінальний висновок користувача');
    expect(afterReview.reviewedAt).not.toBeNull();
  });

  it('регресійний тест: reviewConclusion відхиляється, якщо generateConclusion ніколи не викликався (немає draftedAt)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });
    const meeting = prisma._seedMeeting({ variantId: variant.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.reviewConclusion('u1', meeting.id, 'Спроба обійти генерацію чернетки')).rejects.toThrow(BadRequestException);
  });

  it('generateConclusion без пов’язаної Conversation — BadRequestException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });
    const meeting = prisma._seedMeeting({ variantId: variant.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.generateConclusion('u1', meeting.id)).rejects.toThrow(BadRequestException);
  });

  it('чужий варіант/зустріч дають NotFoundException, не витік чужих даних', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    const variant = prisma._seedVariant({ configId: config.id, label: 'V' });
    const service = makeService(prisma);

    await expect(service.createVariant('attacker', config.id, 'x')).rejects.toThrow(NotFoundException);
    await expect(service.setLocationByPlaceId('attacker', variant.id, 'p1')).rejects.toThrow(NotFoundException);
  });

  it('регресійний тест: getConfig/listVariants/getVariant/getMeeting раніше не існували взагалі (аудит: create-only API)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE', goalDescription: 'Квартира' });
    prisma._seedCriterion({ configId: config.id, text: '2 спальні', isRequired: true, orderIndex: 0 });
    const variant = prisma._seedVariant({ configId: config.id, label: 'Варіант 1' });
    const meeting = prisma._seedMeeting({ variantId: variant.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    const fetchedConfig = await service.getConfig('u1', project.id);
    expect(fetchedConfig.criteria.length).toBe(1);

    const variantsList = await service.listVariants('u1', config.id);
    expect(variantsList.length).toBe(1);

    const fetchedVariant = await service.getVariant('u1', variant.id);
    expect((fetchedVariant as any).meetings.length).toBe(1);

    const fetchedMeeting = await service.getMeeting('u1', meeting.id);
    expect(fetchedMeeting.id).toBe(meeting.id);

    // Чужий доступ так само відхиляється для всіх нових read-методів
    await expect(service.getConfig('attacker', project.id)).rejects.toThrow(NotFoundException);
    await expect(service.listVariants('attacker', config.id)).rejects.toThrow(NotFoundException);
    await expect(service.getVariant('attacker', variant.id)).rejects.toThrow(NotFoundException);
    await expect(service.getMeeting('attacker', meeting.id)).rejects.toThrow(NotFoundException);
  });

  it('регресійний тест: getComparisonTable тепер повертає criteriaBreakdown на варіант (§5.6 ТЗ), не тільки окремі списки criteria/variants', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, category: 'REAL_ESTATE' });
    prisma._seedCriterion({ configId: config.id, text: '2 спальні', isRequired: true, orderIndex: 0 });
    const variantWithConclusion = prisma._seedVariant({ configId: config.id, label: 'З висновком' });
    const variantWithoutConclusion = prisma._seedVariant({ configId: config.id, label: 'Без висновку' });
    prisma._seedMeeting({
      variantId: variantWithConclusion.id,
      conversationId: null,
      occurredAt: new Date(),
      draftedAt: new Date(),
      criteriaBreakdown: [{ criterionId: 'crit-x', covered: 'yes', note: 'Підтверджено' }],
    });
    const service = makeService(prisma);

    const table = await service.getComparisonTable('u1', config.id);

    const withBreakdown = table.variants.find((v: any) => v.id === variantWithConclusion.id);
    const withoutBreakdown = table.variants.find((v: any) => v.id === variantWithoutConclusion.id);

    expect(withBreakdown?.criteriaBreakdown).toEqual([{ criterionId: 'crit-x', covered: 'yes', note: 'Підтверджено' }]);
    // Чесна деградація — null, не порожній масив, коли для варіанту
    // ще жодного разу не викликали generate-conclusion.
    expect(withoutBreakdown?.criteriaBreakdown).toBeNull();
  });
});
