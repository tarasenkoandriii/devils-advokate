// Аудит моделей БД 2026-08-30 §2.4 — удаление аккаунта (GDPR art. 17).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrivacyCenterService } from '../privacy-center/privacy-center.service';

jest.mock('../common/vercel-blob', () => ({
  deleteBlob: jest.fn(async (_token: string, url: string) => { if (url.includes('fail')) throw new Error('403'); }),
}));

function make(opts: { evidence?: any[]; user?: any; token?: string | null } = {}) {
  const calls: any = { deleted: [] as string[], audit: [] as any[] };
  const prisma: any = {
    user: {
      findUnique: async () => opts.user === undefined ? { id: 'u1', telegramId: '123456' } : opts.user,
      delete: async ({ where }: any) => { calls.deleted.push(where.id); return {}; },
    },
    dtpEvidenceItem: { findMany: async () => opts.evidence ?? [] },
    project: { count: async () => 3 }, conversation: { count: async () => 5 }, person: { count: async () => 2 },
    consentRecord: { count: async () => 4 }, intakeSession: { count: async () => 1 }, mediaReviewQueue: { count: async () => 0 },
  };
  const audit = { record: async (r: any) => { calls.audit.push(r); } };
  const secrets = { resolve: async () => (opts.token === undefined ? 'tok' : opts.token) };
  return { svc: new PrivacyCenterService(prisma, audit as any, secrets as any), calls };
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
    const { svc, calls } = make({ evidence: [{ id: 'e1', blobUrl: 'https://blob/ok' }, { id: 'e2', blobUrl: 'https://blob/fail' }] });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(calls.deleted).toEqual(['u1']);
    expect(calls.audit).toHaveLength(1);
    const rec = calls.audit[0];
    expect(rec.action).toBe('user.deleted');
    expect(rec.actorId).toBeNull();
    expect(JSON.stringify(rec)).not.toContain('123456');
    expect(rec.before.telegramIdHash).toHaveLength(16);
    expect(rec.before).toMatchObject({ projects: 3, conversations: 5, evidenceBlobs: 2 });
    expect(res.externalArtifacts).toEqual({ evidenceBlobs: 2, deleted: 1, failed: 1 });
    expect(res.deleted).toBe(true);
    expect(res.notRemovedHere.length).toBeGreaterThan(0);
  });

  it('нет токена Blob — файлы помечаются failed, но аккаунт всё равно удаляется', async () => {
    const { svc, calls } = make({ evidence: [{ id: 'e1', blobUrl: 'https://blob/ok' }], token: null });
    const res = await svc.deleteAccount('u1', 'DELETE');
    expect(res.externalArtifacts).toEqual({ evidenceBlobs: 1, deleted: 0, failed: 1 });
    expect(calls.deleted).toEqual(['u1']);
  });
});
