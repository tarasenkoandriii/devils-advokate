// Аудит 2026-09-02 (продолжение) — внешние артефакты, которые каскад БД
// не трогает: доказательства ДТП, транзитные аудиофайлы разговоров,
// задачи распознавания в полёте. До этого удаление аккаунта знало только
// про первое, удаление проекта — ни про что.
import { ExternalArtifactsCleanupService } from '../common/external-artifacts/external-artifacts-cleanup.service';

jest.mock('../common/vercel-blob', () => ({
  // Пункт [delete-says-done] 2026-09-06: `deleteBlob` больше не
  // бросает и не молчит — она ВОЗВРАЩАЕТ исход. Заглушка обязана знать
  // ту же форму: прежняя бросала исключение, которого production-код
  // не бросает никогда, и потому проверяла не то, что вызывается.
  deleteBlob: jest.fn(async (_token: string, url: string) =>
    url.includes('fail') ? { deleted: false, reason: 'хранилище ответило 403 Forbidden' } : { deleted: true, reason: null },
  ),
}));

function make(data: { evidence?: any[]; conversations?: any[]; sparring?: any[]; material?: any[]; token?: string | null; failPathnames?: string[]; failJobs?: string[] } = {}) {
  const calls = { audioBlobs: [] as string[], discarded: [] as string[], scopes: [] as any[] };
  const prisma: any = {
    dtpEvidenceItem: { findMany: async ({ where }: any) => { calls.scopes.push(where.config); return data.evidence ?? []; } },
    conversation: { findMany: async () => data.conversations ?? [] },
    sparringVoiceReplyJob: { findMany: async () => data.sparring ?? [] },
    materialChatVoiceReplyJob: { findMany: async () => data.material ?? [] },
  };
  const secrets = { resolve: async () => { if (data.token === null) throw new Error('no token'); return data.token ?? 'tok'; } };
  // Пункт [discarded-nothing-said-three] 2026-09-30: оба вызова теперь
  // возвращают ИСХОД, и фейк обязан его отдавать — иначе проверка
  // «найдено и сделано — разные числа» стала бы круговой.
  // `failPathnames` / `failJobs` дают способ проверить неудачу.
  const audioBlob = {
    deleteByPathname: async (p: string) => {
      calls.audioBlobs.push(p);
      return !(data.failPathnames ?? []).includes(p);
    },
  };
  const stt = {
    discardOrphan: async (hint: string, id: string) => {
      calls.discarded.push(`${hint}:${id}`);
      return !(data.failJobs ?? []).includes(`${hint}:${id}`);
    },
  };
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
    expect(report).toEqual({
      evidenceBlobs: 2, evidenceDeleted: 1, evidenceFailed: 1,
      conversationAudioBlobs: 2, conversationAudioDeleted: 2, conversationAudioFailed: 0,
      sttJobsInFlight: 4, sttJobsDiscarded: 4, sttJobsFailed: 0,
    });
    expect(calls.scopes[0]).toEqual({ project: { ownerId: 'u1' } });
  });

  it('область проекта — та же уборка, но по одному проекту', async () => {
    const { svc, calls } = make({ conversations: [{ id: 'c1', audioBlobPathname: 'conversation-audio/c1/a.m4a', status: 'UPLOADED', externalTranscriptionJobId: null }] });
    const report = await svc.discardForProject('p1');
    expect(calls.scopes[0]).toEqual({ project: { id: 'p1' } });
    expect(report.conversationAudioBlobs).toBe(1);
  });

  it('РЕГРЕССИЯ (отставание миграции): база без значения PROCESSING — удаление не падает, ищутся только PENDING', async () => {
    const { svc, calls } = make({ sparring: [{ externalTranscriptionJobId: 'soniox:vr-1' }] });
    const prisma: any = (svc as any).prisma;
    const original = prisma.sparringVoiceReplyJob.findMany;
    prisma.sparringVoiceReplyJob.findMany = async ({ where }: any) => {
      if (where.status.in.includes('PROCESSING')) throw new Error('invalid input value for enum "SparringVoiceReplyStatus": "PROCESSING"');
      return original({ where });
    };
    const report = await svc.discardForUser('u1');
    expect(report.sttJobsInFlight).toBe(1);
    expect(report.sttJobsDiscarded).toBe(1);
    expect(report.sttJobsFailed).toBe(0);
    expect(calls.discarded).toEqual(['soniox:vr-1']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ, Пункт [discarded-nothing-said-three] 2026-09-30: найдено и сделано — разные числа', async () => {
    // Прежде отчёт имел по ОДНОМУ полю на каждый вид, и оба были
    // числами найденного. Экран печатал их как «удалено» и
    // «отозвано», а запись человека оставалась у субподрядчика весь
    // retention — и то же завышенное число уходило в аудит
    // `user.deleted`.
    const { svc } = make({
      conversations: [
        { id: 'c1', audioBlobPathname: 'a/1.m4a', status: 'TRANSCRIBING', externalTranscriptionJobId: 'soniox:tr-1' },
        { id: 'c2', audioBlobPathname: 'a/2.m4a', status: 'UPLOADED', externalTranscriptionJobId: null },
      ],
      material: [{ externalTranscriptionJobId: 'elevenlabs:mc-1' }],
      failPathnames: ['a/2.m4a'],
      // ElevenLabs — универсальный последний фоллбек цепочки — отзыва
      // не умеет вовсе: `discard` у него не реализован.
      failJobs: ['elevenlabs:mc-1'],
    });
    const report = await svc.discardForUser('u1');
    expect(report.conversationAudioBlobs).toBe(2);
    expect(report.conversationAudioDeleted).toBe(1);
    expect(report.conversationAudioFailed).toBe(1);
    expect(report.sttJobsInFlight).toBe(2);
    expect(report.sttJobsDiscarded).toBe(1);
    expect(report.sttJobsFailed).toBe(1);
  });

  it('нет токена Blob — доказательства помечаются failed, остальное всё равно убирается', async () => {
    const { svc, calls } = make({ token: null, evidence: [{ id: 'e1', blobUrl: 'https://blob/ok' }], conversations: [{ id: 'c1', audioBlobPathname: 'x', status: 'UPLOADED', externalTranscriptionJobId: null }] });
    const report = await svc.discardForUser('u1');
    expect(report).toMatchObject({ evidenceBlobs: 1, evidenceDeleted: 0, evidenceFailed: 1, conversationAudioBlobs: 1 });
    expect(calls.audioBlobs).toEqual(['x']);
  });
});
