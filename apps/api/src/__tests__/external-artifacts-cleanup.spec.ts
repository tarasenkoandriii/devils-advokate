// Аудит 2026-09-02 (продолжение) — внешние артефакты, которые каскад БД
// не трогает: доказательства ДТП, транзитные аудиофайлы разговоров,
// задачи распознавания в полёте. До этого удаление аккаунта знало только
// про первое, удаление проекта — ни про что.
import { ExternalArtifactsCleanupService } from '../common/external-artifacts/external-artifacts-cleanup.service';

jest.mock('../common/vercel-blob', () => ({
  deleteBlob: jest.fn(async (_token: string, url: string) => { if (url.includes('fail')) throw new Error('403'); }),
}));

function make(data: { evidence?: any[]; conversations?: any[]; sparring?: any[]; material?: any[]; token?: string | null } = {}) {
  const calls = { audioBlobs: [] as string[], discarded: [] as string[], scopes: [] as any[] };
  const prisma: any = {
    dtpEvidenceItem: { findMany: async ({ where }: any) => { calls.scopes.push(where.config); return data.evidence ?? []; } },
    conversation: { findMany: async () => data.conversations ?? [] },
    sparringVoiceReplyJob: { findMany: async () => data.sparring ?? [] },
    materialChatVoiceReplyJob: { findMany: async () => data.material ?? [] },
  };
  const secrets = { resolve: async () => { if (data.token === null) throw new Error('no token'); return data.token ?? 'tok'; } };
  const audioBlob = { deleteByPathname: async (p: string) => { calls.audioBlobs.push(p); } };
  const stt = { discardOrphan: async (hint: string, id: string) => { calls.discarded.push(`${hint}:${id}`); } };
  return { svc: new ExternalArtifactsCleanupService(prisma, secrets as any, audioBlob as any, stt as any), calls };
}

describe('ExternalArtifactsCleanupService', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: файлы разговоров удаляются, задачи в полёте отзываются у провайдера (префикс или голый legacy-id = AssemblyAI), доказательства ДТП считаются', async () => {
    const { svc, calls } = make({
      evidence: [{ id: 'e1', blobUrl: 'https://blob/ok' }, { id: 'e2', blobUrl: 'https://blob/fail' }],
      conversations: [
        { id: 'c1', audioBlobPathname: 'conversation-audio/c1/a.m4a', status: 'TRANSCRIBING', externalTranscriptionJobId: 'soniox:tr-1' },
        { id: 'c2', audioBlobPathname: 'conversation-audio/c2/b.m4a', status: 'UPLOADED', externalTranscriptionJobId: null },
        { id: 'c3', audioBlobPathname: null, status: 'TRANSCRIBING', externalTranscriptionJobId: 'legacy-assembly-id' },
      ],
      sparring: [{ externalTranscriptionJobId: 'soniox:vr-1' }],
      material: [{ externalTranscriptionJobId: 'assemblyai:mc-1' }],
    });
    const report = await svc.discardForUser('u1');
    expect(calls.audioBlobs).toEqual(['conversation-audio/c1/a.m4a', 'conversation-audio/c2/b.m4a']);
    expect(calls.discarded).toEqual(['soniox:tr-1', 'assemblyai:legacy-assembly-id', 'soniox:vr-1', 'assemblyai:mc-1']);
    expect(report).toEqual({ evidenceBlobs: 2, evidenceDeleted: 1, evidenceFailed: 1, conversationAudioBlobs: 2, sttJobsDiscarded: 4 });
    expect(calls.scopes[0]).toEqual({ project: { ownerId: 'u1' } });
  });

  it('область проекта — та же уборка, но по одному проекту', async () => {
    const { svc, calls } = make({ conversations: [{ id: 'c1', audioBlobPathname: 'conversation-audio/c1/a.m4a', status: 'UPLOADED', externalTranscriptionJobId: null }] });
    const report = await svc.discardForProject('p1');
    expect(calls.scopes[0]).toEqual({ project: { id: 'p1' } });
    expect(report.conversationAudioBlobs).toBe(1);
  });

  it('нет токена Blob — доказательства помечаются failed, остальное всё равно убирается', async () => {
    const { svc, calls } = make({ token: null, evidence: [{ id: 'e1', blobUrl: 'https://blob/ok' }], conversations: [{ id: 'c1', audioBlobPathname: 'x', status: 'UPLOADED', externalTranscriptionJobId: null }] });
    const report = await svc.discardForUser('u1');
    expect(report).toMatchObject({ evidenceBlobs: 1, evidenceDeleted: 0, evidenceFailed: 1, conversationAudioBlobs: 1 });
    expect(calls.audioBlobs).toEqual(['x']);
  });
});
