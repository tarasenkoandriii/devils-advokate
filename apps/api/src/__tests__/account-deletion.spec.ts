// Аудит моделей БД 2026-08-30 §2.4 — удаление аккаунта (GDPR art. 17).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrivacyCenterService } from '../privacy-center/privacy-center.service';

import type { ExternalArtifactsReport as Report } from '../common/external-artifacts/external-artifacts-cleanup.service';

// Уборка внешних артефактов вынесена в ExternalArtifactsCleanupService
// (аудит 2026-09-02, продолжение) и покрыта своей спекой; здесь она —
// фейк с настраиваемым отчётом. Проверяется порядок: артефакты → аудит →
// user.delete, и что отчёт доезжает до ответа и журнала.
function make(opts: { report?: Partial<Report>; user?: any; aiJobs?: any[] } = {}) {
  const calls: any = { deleted: [] as string[], audit: [] as any[], cleanupFor: [] as string[], aiUpdates: [] as any[], inferencesDeletedFor: [] as string[][] };
  const aiJobs = opts.aiJobs ?? [];
  const prisma: any = {
    user: {
      findUnique: async () => opts.user === undefined ? { id: 'u1', telegramId: '123456' } : opts.user,
      delete: async ({ where }: any) => { calls.deleted.push(where.id); return {}; },
    },
    // Аудит 2026-09-02 (продолжение): следы AI-вызовов после каскада.
    aIJob: {
      findMany: async ({ where }: any) => aiJobs.filter((j) => j.requestUserId === where.requestUserId).map((j) => ({ id: j.id })),
      updateMany: async ({ where, data }: any) => {
        const hit = aiJobs.filter((j) => where.id.in.includes(j.id)
          && (!where.status || (where.status.in ? where.status.in.includes(j.status) : where.status.not ? j.status !== where.status.not : true)));
        for (const j of hit) Object.assign(j, data);
        calls.aiUpdates.push({ where, data });
        return { count: hit.length };
      },
    },
    aIInference: {
      deleteMany: async ({ where }: any) => { calls.inferencesDeletedFor.push(where.aiJobId.in); return { count: where.aiJobId.in.length * 2 }; },
    },
    project: { count: async () => 3 }, conversation: { count: async () => 5 }, person: { count: async () => 2 },
    consentRecord: { count: async () => 4 }, intakeSession: { count: async () => 1 }, mediaReviewQueue: { count: async () => 0 },
  };
  const audit = { record: async (r: any) => { calls.audit.push(r); } };
  const report: Report = { evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0, ...opts.report };
  const cleanup = { discardForUser: async (userId: string) => { calls.cleanupFor.push(userId); return report; } };
  return { svc: new PrivacyCenterService(prisma, audit as any, cleanup as any), calls };
}

describe('deleteAccount', () => {
  it('без confirmation="DELETE" — BadRequest, ничего не удаляется', async () => {
    const { svc, calls } = make();
    await expect(svc.deleteAccount('u1', 'yes')).rejects.toThrow(BadRequestException);
    expect(calls.deleted).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('несуществующий пользователь — NotFound', async () => {
    const { svc } = make({ user: null });
    await expect(svc.deleteAccount('u1', 'DELETE')).rejects.toThrow(NotFoundException);
  });

  it('порядок: blob → аудит (без telegramId, с хешем и счётчиками) → user.delete; отчёт о внешних артефактах', async () => {
    const { svc, calls } = make({ report: { evidenceBlobs: 2, evidenceDeleted: 1, evidenceFailed: 1 } });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(calls.deleted).toEqual(['u1']);
    expect(calls.audit).toHaveLength(1);
    const rec = calls.audit[0];
    expect(rec.action).toBe('user.deleted');
    expect(rec.actorId).toBeNull();
    expect(JSON.stringify(rec)).not.toContain('123456');
    expect(rec.before.telegramIdHash).toHaveLength(16);
    expect(rec.before).toMatchObject({ projects: 3, conversations: 5, evidenceBlobs: 2 });
    expect(res.externalArtifacts).toMatchObject({ evidenceBlobs: 2, deleted: 1, failed: 1 });
    expect(calls.cleanupFor).toEqual(['u1']);
    expect(res.deleted).toBe(true);
    expect(res.notRemovedHere.length).toBeGreaterThan(0);
  });

  it('РЕГРЕССИЯ (аудит 2026-09-02): отчёт об аудио разговоров и задачах распознавания в полёте доезжает до ответа и журнала аудита', async () => {
    const { svc, calls } = make({ report: { conversationAudioBlobs: 2, sttJobsDiscarded: 3 } });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(res.externalArtifacts).toMatchObject({ conversationAudioBlobs: 2, sttJobsDiscarded: 3 });
    expect(calls.audit[0].before).toMatchObject({ conversationAudioBlobs: 2, sttJobsInFlight: 3 });
    expect(calls.audit[0].after).toMatchObject({ sttJobsDiscarded: 3 });
    expect(calls.deleted).toEqual(['u1']);
  });

  it('РЕГРЕССИЯ (аудит 2026-09-02): после каскада выводы AI удаляются, неисполненные джобы отменяются, тексты запросов обнуляются — строки джоб остаются для телеметрии', async () => {
    const aiJobs = [
      { id: 'j-done', requestUserId: 'u1', status: 'COMPLETED', pendingRequest: null, partialResult: 'обрывок' },
      { id: 'j-queued', requestUserId: 'u1', status: 'QUEUED', pendingRequest: { userPrompt: 'моя ситуация целиком' }, partialResult: null },
      { id: 'j-other', requestUserId: 'u2', status: 'QUEUED', pendingRequest: { userPrompt: 'чужое' }, partialResult: null },
    ];
    const { svc, calls } = make({ aiJobs });
    const res = await svc.deleteAccount('u1', 'DELETE');
    // requestUserId — не FK: до правки всё это оставалось в ai_jobs /
    // ai_inferences после удаления аккаунта.
    expect(calls.inferencesDeletedFor).toEqual([['j-done', 'j-queued']]);
    expect(aiJobs[1]).toMatchObject({ status: 'CANCELLED' });
    expect(aiJobs[1].pendingRequest).not.toEqual({ userPrompt: 'моя ситуация целиком' });
    expect(aiJobs[0].partialResult).toBeNull();
    expect(aiJobs[2]).toMatchObject({ status: 'QUEUED', pendingRequest: { userPrompt: 'чужое' } }); // чужие джобы не тронуты
    expect(res.removed).toMatchObject({ aiInferences: 4, aiJobsCancelled: 1 });
    // Следы AI чистятся ПОСЛЕ каскада: ссылки на инференсы из сущностей
    // пользователя к этому моменту уже сняты.
    expect(calls.deleted).toEqual(['u1']);
  });

  it('файлы, которые не удалились (нет токена Blob и т. п.), помечаются failed — аккаунт всё равно удаляется', async () => {
    const { svc, calls } = make({ report: { evidenceBlobs: 1, evidenceDeleted: 0, evidenceFailed: 1 } });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(res.externalArtifacts).toMatchObject({ evidenceBlobs: 1, deleted: 0, failed: 1 });
    expect(calls.deleted).toEqual(['u1']);
  });
});
