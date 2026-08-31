// Фаза A ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md — read-helper'ы,
// общие для шести доменных конвейеров.
import { NotFoundException } from '@nestjs/common';
import { getOnboardingAnswers, listDomainProjects, DOMAIN_PROJECTS_MAX_TAKE } from '../common/domain-onboarding-reads';

function createFakePrisma() {
  const projects: any[] = [];
  const conversations: any[] = [];
  const transcripts: any[] = [];
  return {
    _seedProject(p: any) { projects.push({ createdAt: new Date(), updatedAt: new Date(), ...p }); },
    _seedConversation(c: any) { conversations.push(c); },
    _seedTranscript(t: any) { transcripts.push(t); },
    project: {
      findMany: async ({ where, take, skip }: any) =>
        projects.filter((p) => p.ownerId === where.ownerId && p.mode === where.mode).slice(skip, skip + take),
      count: async ({ where }: any) => projects.filter((p) => p.ownerId === where.ownerId && p.mode === where.mode).length,
    },
    conversation: {
      findFirst: async ({ where }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        if (!c) return null;
        const p = projects.find((x) => x.id === c.projectId);
        return p && p.ownerId === where.project.ownerId ? c : null;
      },
    },
    transcript: {
      findUnique: async ({ where }: any) => {
        const t = transcripts.find((x) => x.conversationId === where.conversationId);
        return t ? { ...t, segments: [...t.segments].sort((a, b) => a.startMs - b.startMs) } : null;
      },
    },
  };
}

describe('domain-onboarding-reads (фаза A)', () => {
  it('listDomainProjects фильтрует по владельцу И режиму — проекты другого домена не попадают', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: 'u1', mode: 'DTP', question: 'a' });
    prisma._seedProject({ id: 'p2', ownerId: 'u1', mode: 'HEALTH', question: 'b' });
    prisma._seedProject({ id: 'p3', ownerId: 'u2', mode: 'DTP', question: 'c' });
    const res = await listDomainProjects(prisma as any, 'u1', 'DTP' as any);
    expect(res.items.map((p) => p.id)).toEqual(['p1']);
    expect(res.total).toBe(1);
  });

  it('take ограничен потолком, skip не бывает отрицательным', async () => {
    const prisma = createFakePrisma();
    const res = await listDomainProjects(prisma as any, 'u1', 'DTP' as any, { take: 10_000, skip: -5 });
    expect(res.take).toBe(DOMAIN_PROJECTS_MAX_TAKE);
    expect(res.skip).toBe(0);
  });

  it('getOnboardingAnswers возвращает ответы в порядке startMs', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: 'u1', mode: 'DTP' });
    prisma._seedConversation({ id: 'c1', projectId: 'p1', status: 'UPLOADED', createdAt: new Date() });
    prisma._seedTranscript({ conversationId: 'c1', segments: [
      { id: 's2', text: 'второй', startMs: 10 },
      { id: 's1', text: 'первый', startMs: 1 },
    ] });
    const res = await getOnboardingAnswers(prisma as any, 'u1', 'c1');
    expect(res.answers.map((a) => a.text)).toEqual(['первый', 'второй']);
  });

  it('getOnboardingAnswers чужого разговора — NotFoundException, не пустой список', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: 'u1', mode: 'DTP' });
    prisma._seedConversation({ id: 'c1', projectId: 'p1' });
    await expect(getOnboardingAnswers(prisma as any, 'attacker', 'c1')).rejects.toThrow(NotFoundException);
  });
});

// Добивка create-only (2026-08-30): списки «мои профили кандидатов / команды / группы».
import { InterviewPoolCandidateService } from '../interview-pool/interview-pool-candidate.service';
import { InterviewPoolTeamService } from '../interview-pool/interview-pool-team.service';
import { InvestmentGroupService } from '../investment/investment-group.service';

describe('«мои» списки для create-only коллекций', () => {
  it('listMyCandidates: свои + расшаренные в мои команды, чужие без команды — нет', async () => {
    const prisma: any = {
      recruitingTeamMember: { findMany: async () => [{ teamId: 't1' }] },
      candidateProfile: { findMany: async ({ where }: any) => {
        const all = [
          { id: 'mine', ownerUserId: 'u1', recruitingTeamId: null, displayName: 'A' },
          { id: 'team', ownerUserId: 'u2', recruitingTeamId: 't1', displayName: 'B' },
          { id: 'other', ownerUserId: 'u2', recruitingTeamId: 't9', displayName: 'C' },
        ];
        const ors = where.OR as any[];
        return all.filter((c) => ors.some((o) => (o.ownerUserId && c.ownerUserId === o.ownerUserId) || (o.recruitingTeamId && o.recruitingTeamId.in.includes(c.recruitingTeamId))));
      } },
    };
    const svc = new (InterviewPoolCandidateService as any)(prisma);
    const res = await svc.listMyCandidates('u1');
    expect(res.map((c: any) => c.id).sort()).toEqual(['mine', 'team']);
  });

  it('listMyTeams / listMyGroups: плоская форма — поля команды/группы + роль/взнос', async () => {
    const teamPrisma: any = { recruitingTeamMember: { findMany: async () => [{ role: 'OWNER', joinedAt: new Date(0), team: { id: 't1', name: 'T', createdAt: new Date(0), _count: { members: 3 } } }] } };
    const teams = await new (InterviewPoolTeamService as any)(teamPrisma).listMyTeams('u1');
    expect(teams[0]).toMatchObject({ id: 't1', name: 'T', role: 'OWNER', _count: { members: 3 } });
    const groupPrisma: any = { investmentGroupMember: { findMany: async () => [{ pledgedAmount: 500, joinedAt: new Date(0), group: { id: 'g1', name: 'G', createdAt: new Date(0), _count: { members: 2 } } }] } };
    const groups = await new (InvestmentGroupService as any)(groupPrisma).listMyGroups('u1');
    expect(groups[0]).toMatchObject({ id: 'g1', name: 'G', pledgedAmount: 500 });
  });
});
