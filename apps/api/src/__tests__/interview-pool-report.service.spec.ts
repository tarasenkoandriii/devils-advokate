import { BadRequestException } from '@nestjs/common';
import { InterviewPoolReportService } from '../interview-pool/interview-pool-report.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const statuses: any[] = [];
  const candidates = new Map<string, any>();
  const configs = new Map<string, any>();
  const questions: any[] = [];
  const snapshots: any[] = [];
  const entries: any[] = [];
  const reports = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedCandidate(c: any) {
      const candidate = { id: nextId(), ...c };
      candidates.set(candidate.id, candidate);
      return candidate;
    },
    _seedStatus(s: any) {
      const status = { id: nextId(), stage: 'SCHEDULED', ...s };
      statuses.push(status);
      return status;
    },
    _seedConfig(c: any) {
      const config = { id: nextId(), ...c };
      configs.set(config.id, config);
      return config;
    },
    _seedQuestion(q: any) {
      questions.push({ id: nextId(), isRequired: true, ...q });
      return questions[questions.length - 1];
    },
    _seedSnapshotWithEntries(projectId: string, entryList: any[]) {
      const snap = { id: nextId(), projectId, createdAt: new Date() };
      snapshots.push(snap);
      entryList.forEach((e) => entries.push({ id: nextId(), snapshotId: snap.id, ...e }));
      return snap;
    },
    _seedReport(r: any) {
      const report = { id: nextId(), reviewedAt: null, sentAt: null, ...r };
      reports.set(report.id, report);
      return report;
    },

    project: { findUnique: async ({ where }: any) => projects.get(where.id) ?? null },
    recruitingTeamMember: { findUnique: async () => null },
    candidatePipelineStatus: {
      findUnique: async ({ where }: any) => {
        const key = where.projectId_candidateProfileId;
        const s = statuses.find((s) => s.projectId === key.projectId && s.candidateProfileId === key.candidateProfileId);
        if (!s) return null;
        return { ...s, candidateProfile: candidates.get(s.candidateProfileId), stageProgress: [] };
      },
      findMany: async ({ where, include }: any) =>
        statuses
          .filter((s) => s.projectId === where.projectId)
          .map((s) => ({ ...s, candidateProfile: include?.candidateProfile ? candidates.get(s.candidateProfileId) : undefined })),
    },
    poolRelevanceSnapshot: {
      findFirst: async ({ where }: any) => {
        const rows = snapshots.filter((s) => s.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt);
        const snap = rows[0];
        if (!snap) return null;
        return { ...snap, entries: entries.filter((e) => e.snapshotId === snap.id) };
      },
    },
    interviewPoolConfig: {
      findUnique: async ({ where, include }: any) => {
        const config = [...configs.values()].find((c) => c.projectId === where.projectId);
        if (!config) return null;
        if (include?.questions) {
          return { ...config, questions: questions.filter((q) => q.configId === config.id && (include.questions.where?.isRequired === undefined || q.isRequired === include.questions.where.isRequired)) };
        }
        return config;
      },
    },
    clientReport: {
      create: async ({ data }: any) => {
        const report = { id: nextId(), reviewedAt: null, sentAt: null, draftedAt: new Date(), ...data };
        reports.set(report.id, report);
        return report;
      },
      findUnique: async ({ where }: any) => reports.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const r = reports.get(where.id);
        Object.assign(r, data);
        return r;
      },
    },
  };
}

function makeService(prisma: any, aiRouter: any = { execute: async () => ({ text: JSON.stringify({ conclusion: 'Висновок' }) }) }) {
  return new InterviewPoolReportService(prisma as any, aiRouter as any);
}

describe('InterviewPoolReportService', () => {
  it('acceptance-тест §7 ТЗ: send БЕЗ попереднього review — 400, reviewedAt обов\'язковий', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const report = prisma._seedReport({ projectId: project.id, type: 'SUMMARY', content: {} });
    const service = makeService(prisma);

    await expect(service.send('u1', report.id, 'Telegram')).rejects.toThrow(BadRequestException);
  });

  it('review → send працює послідовно, sentAt заповнюється тільки після review', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const report = prisma._seedReport({ projectId: project.id, type: 'SUMMARY', content: {} });
    const service = makeService(prisma);

    await service.review('u1', report.id);
    const sent = await service.send('u1', report.id, 'Telegram');

    expect(sent.sentAt).not.toBeNull();
    expect(sent.reviewedByUserId).toBe('u1');
  });

  it('acceptance-тест §7 ТЗ: SUMMARY-звіт впорядковує entries за прозорою coverage-метрикою, не прихованим AI-балом', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend' });
    const q1 = prisma._seedQuestion({ configId: config.id, isRequired: true });
    const q2 = prisma._seedQuestion({ configId: config.id, isRequired: true });
    const strongCandidate = prisma._seedCandidate({ displayName: 'Сильний кандидат' });
    const weakCandidate = prisma._seedCandidate({ displayName: 'Слабший кандидат' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: strongCandidate.id, stage: 'INTERVIEWED' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: weakCandidate.id, stage: 'INTERVIEWED' });
    prisma._seedSnapshotWithEntries(project.id, [
      { candidateProfileId: strongCandidate.id, criteriaBreakdown: [{ questionnaireItemId: q1.id, coverage: 'covered' }, { questionnaireItemId: q2.id, coverage: 'covered' }] },
      { candidateProfileId: weakCandidate.id, criteriaBreakdown: [{ questionnaireItemId: q1.id, coverage: 'not_covered' }, { questionnaireItemId: q2.id, coverage: 'not_covered' }] },
    ]);
    const service = makeService(prisma);

    const report = await service.generateSummaryReport('u1', project.id);
    const content = report.content as any;

    expect(content.entries[0].candidateProfileId).toBe(strongCandidate.id);
    expect(content.entries[0].coverageScore).toBe(1);
    expect(content.entries[1].coverageScore).toBe(0);
    expect(content.funnel.totalCandidates).toBe(2);
  });

  it('acceptance-тест §7 ТЗ: ComplianceFlag НІКОЛИ не потрапляє в content жодного звіту — перевірка на серіалізацію', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend' });
    const candidate = prisma._seedCandidate({ displayName: 'Кандидат' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    const service = makeService(prisma);

    const candidateReport = await service.generateCandidateReport('u1', project.id, candidate.id);
    const summaryReport = await service.generateSummaryReport('u1', project.id);

    const serializedCandidate = JSON.stringify(candidateReport.content);
    const serializedSummary = JSON.stringify(summaryReport.content);
    // ComplianceFlag ніколи навіть не читається цим сервісом — жодного
    // виклику prisma.complianceFlag.* немає в коді InterviewPoolReportService,
    // тому й перевіряти в content нічого зайвого не з'явиться структурно.
    expect(serializedCandidate.toLowerCase()).not.toContain('compliance');
    expect(serializedSummary.toLowerCase()).not.toContain('compliance');
  });

  it('updateContent відхиляється, якщо звіт вже надіслано', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const report = prisma._seedReport({ projectId: project.id, type: 'SUMMARY', content: {}, sentAt: new Date() });
    const service = makeService(prisma);

    await expect(service.updateContent('u1', report.id, { edited: true })).rejects.toThrow(BadRequestException);
  });
});
