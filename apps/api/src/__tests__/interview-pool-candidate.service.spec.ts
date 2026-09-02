import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InterviewPoolCandidateService } from '../interview-pool/interview-pool-candidate.service';

// Пункт [deep-links] 2026-09-02: ссылки-приглашения строятся из
// окружения. Раньше в них стоял литерал `t.me/<bot>` — ссылка в никуда
// при живом токене; теперь без переменной сервис честно отвечает 503,
// поэтому тестам нужна заданная переменная.
process.env.TELEGRAM_BOT_USERNAME = 'da_test_bot';

function createFakePrisma() {
  const candidates = new Map<string, any>();
  const statuses: any[] = [];
  const shares: any[] = [];
  const followUpRequests: any[] = [];
  const teamMembers: any[] = [];
  const projects = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedCandidate(c: any) {
      const candidate = { id: nextId(), ...c };
      candidates.set(candidate.id, candidate);
      return candidate;
    },
    _seedProject(p: any) {
      // Пункт [interview-pool-mode] 2026-09-02: доступ теперь проверяет
      // и режим проекта (как в job-search) — фейку нужен режим по
      // умолчанию, иначе тесты домена проверяли бы чужой сценарий.
      const project = { id: nextId(), mode: 'INTERVIEW_POOL', ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedStatus(s: any) {
      const status = { id: nextId(), ...s };
      statuses.push(status);
      return status;
    },
    _seedFollowUp(f: any) {
      const req = { id: nextId(), fulfilled: false, ...f };
      followUpRequests.push(req);
      return req;
    },
    _seedTeamMembership(m: any) {
      teamMembers.push(m);
    },
    _getShares() {
      return shares;
    },

    project: {
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    candidateProfile: {
      findUnique: async ({ where }: any) => candidates.get(where.id) ?? null,
      create: async ({ data }: any) => {
        const c = { id: nextId(), ...data };
        candidates.set(c.id, c);
        return c;
      },
    },
    recruitingTeamMember: {
      findUnique: async ({ where }: any) =>
        teamMembers.find((m) => m.teamId === where.teamId_userId.teamId && m.userId === where.teamId_userId.userId) ?? null,
    },
    candidatePipelineStatus: {
      findUnique: async ({ where }: any) => statuses.find((s) => s.id === where.id) ?? null,
      findMany: async ({ where, select }: any) => {
        const rows = statuses.filter((s) => s.projectId === where.projectId);
        return select ? rows.map((s) => ({ candidateProfileId: s.candidateProfileId })) : rows;
      },
    },
    candidateFollowUpRequest: {
      findMany: async ({ where }: any) => followUpRequests.filter((f) => f.statusId === where.statusId),
      findUnique: async ({ where }: any) => followUpRequests.find((f) => f.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const f = followUpRequests.find((r) => r.id === where.id);
        Object.assign(f, data);
        return f;
      },
    },
    candidateShare: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), acceptedAt: null, acceptedByUserId: null, ...data };
        shares.push(s);
        return s;
      },
      createMany: async ({ data }: any) => {
        data.forEach((d: any) => shares.push({ id: nextId(), acceptedAt: null, acceptedByUserId: null, ...d }));
      },
      findMany: async ({ where }: any) => {
        return shares
          .filter((s) => (where.OR ? where.OR.some((c: any) => (c.shareToken && s.shareToken === c.shareToken) || (c.batchToken && s.batchToken === c.batchToken)) : true))
          .map((s) => ({ ...s, sourceCandidate: candidates.get(s.sourceCandidateId) }));
      },
      findUnique: async ({ where }: any) => {
        const s = shares.find((sh) => sh.id === where.id);
        if (!s) return null;
        return { ...s, sourceCandidate: candidates.get(s.sourceCandidateId) };
      },
      update: async ({ where, data }: any) => {
        const s = shares.find((sh) => sh.id === where.id);
        Object.assign(s, data);
        return s;
      },
    },
  };
}

function makeService(prisma: any) {
  return new InterviewPoolCandidateService(prisma as any);
}

describe('InterviewPoolCandidateService', () => {
  it('createCandidate відхиляє порожній displayName', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);
    await expect(service.createCandidate('u1', '  ')).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ: shareCandidate без candidateConsentConfirmed=true — 400, посилання НЕ генерується', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const service = makeService(prisma);

    await expect(service.shareCandidate('u1', candidate.id, false)).rejects.toThrow(BadRequestException);
    expect(prisma._getShares().length).toBe(0);
  });

  it('shareCandidate з candidateConsentConfirmed=true генерує deep-link', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const service = makeService(prisma);

    const result = await service.shareCandidate('u1', candidate.id, true);

    expect(result.deepLink).toContain('share_');
    // Аудит 2026-09-02: раньше здесь был литерал «t.me/<bot>» — тест
    // проходил, а ссылка вела в никуда. Проверяем реальный адрес.
    expect(result.deepLink).toContain('https://t.me/da_test_bot?start=share_');
    expect(prisma._getShares().length).toBe(1);
    expect(prisma._getShares()[0].shareToken).toBeDefined();
    expect(prisma._getShares()[0].batchToken).toBeUndefined();
  });

  it('acceptance-тест §7 ТЗ: пакетний шеринг 5 кандидатів, згода підтверджена тільки для 3 — includedCount=3, excludedCount=2, БЕЗ помилки на весь запит', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const consented: string[] = [];
    for (let i = 0; i < 5; i++) {
      const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: `Кандидат ${i}` });
      prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
      if (i < 3) consented.push(candidate.id);
    }
    const service = makeService(prisma);

    const result = await service.shareAllInPool('u1', project.id, consented);

    expect(result.includedCount).toBe(3);
    expect(result.excludedCount).toBe(2);
    // Регресійний тест на реальну знахідку аудиту: усі рядки пакету
    // мають ОДНАКОВИЙ batchToken (не shareToken — той @unique, не міг
    // би належати кільком рядкам одразу).
    const batchShares = prisma._getShares();
    expect(batchShares.length).toBe(3);
    expect(new Set(batchShares.map((s: any) => s.batchToken)).size).toBe(1);
    expect(batchShares.every((s: any) => s.shareToken == null)).toBe(true);
  });

  it('регресійний тест (КРИТИЧНИЙ, аудит): shareAllInPool відхиляє виклик від користувача БЕЗ доступу до проєкту — раніше цієї перевірки не було взагалі', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const candidate = prisma._seedCandidate({ ownerUserId: 'owner', displayName: 'Кандидат' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    const service = makeService(prisma);

    await expect(service.shareAllInPool('attacker', project.id, [candidate.id])).rejects.toThrow(NotFoundException);
    // Жодного CandidateShare не мало створитись через відхилений запит
    expect(prisma._getShares().length).toBe(0);
  });

  it('member команди МОЖЕ пакетно поділитись пулом команди (§4.5 ТЗ)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner', recruitingTeamId: 'team-1' });
    prisma._seedTeamMembership({ teamId: 'team-1', userId: 'colleague' });
    const candidate = prisma._seedCandidate({ recruitingTeamId: 'team-1', displayName: 'Кандидат' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    const service = makeService(prisma);

    const result = await service.shareAllInPool('colleague', project.id, [candidate.id]);

    expect(result.includedCount).toBe(1);
  });

  it('пакетний шеринг без жодного підтвердженого кандидата — BadRequestException, не порожній пакет', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    const service = makeService(prisma);

    await expect(service.shareAllInPool('u1', project.id, [])).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ: previewShare відповідь НЕ містить pipelineStatuses/relevanceEntries — тільки displayName/resumeText', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат', resumeText: 'CV текст' });
    const service = makeService(prisma);
    const { deepLink } = await service.shareCandidate('u1', candidate.id, true);
    const token = deepLink.split('share_')[1];

    const preview = await service.previewShare(token);

    expect(preview[0]).toEqual({ shareId: expect.any(String), displayName: 'Кандидат', resumeText: 'CV текст' });
    expect(Object.keys(preview[0])).not.toContain('pipelineStatuses');
    expect(Object.keys(preview[0])).not.toContain('relevanceEntries');
  });

  it('acceptDate — явна дія отримувача, створює НОВИЙ CandidateProfile (копію), не live-посилання', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат', resumeText: 'CV' });
    const service = makeService(prisma);
    const { deepLink } = await service.shareCandidate('u1', candidate.id, true);
    const token = deepLink.split('share_')[1];
    const [preview] = await service.previewShare(token);

    // [project-audit] 2026-09-01: одного shareId (внутрішній cuid) вже
    // недостатньо — потрібен токен з deep-link (фікс IDOR зі звіту).
    await expect(service.acceptShare('u2', preview.shareId, 'wrong-token')).rejects.toThrow(NotFoundException);
    await expect(service.acceptShare('u2', preview.shareId, '')).rejects.toThrow(NotFoundException);

    const accepted = await service.acceptShare('u2', preview.shareId, token);

    expect(accepted.id).not.toBe(candidate.id);
    expect(accepted.ownerUserId).toBe('u2');
    expect(accepted.displayName).toBe('Кандидат');

    // Повторне прийняття того самого посилання — відхиляється
    await expect(service.acceptShare('u2', preview.shareId, token)).rejects.toThrow(BadRequestException);
  });

  it('чужий кандидат (не власник, не член команди) — NotFoundException при спробі поділитись', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'owner', displayName: 'Кандидат' });
    const service = makeService(prisma);

    await expect(service.shareCandidate('attacker', candidate.id, true)).rejects.toThrow(NotFoundException);
  });

  it('член команди має доступ до командного кандидата (§4.5 ТЗ)', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ recruitingTeamId: 'team-1', displayName: 'Кандидат' });
    prisma._seedTeamMembership({ teamId: 'team-1', userId: 'colleague' });
    const service = makeService(prisma);

    await expect(service.shareCandidate('colleague', candidate.id, true)).resolves.toBeDefined();
  });
});
