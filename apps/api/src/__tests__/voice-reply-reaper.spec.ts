// Аудит 2026-09-02 (продолжение) — сторожевая голосовых реплик.
//
// До неё у SparringVoiceReplyJob / MaterialChatVoiceReplyJob не было
// терминального исхода без вебхука: PENDING (или PROCESSING) навсегда,
// клиент опрашивал бесконечно. Здесь проверяется, что протухшее
// переводится в FAILED с причиной, а свежее — не трогается.
import {
  VoiceReplyReaperService,
  VOICE_REPLY_PENDING_MAX_AGE_MS,
  VOICE_REPLY_PROCESSING_MAX_AGE_MS,
} from '../stt/voice-reply-reaper.service';

interface Job { id: string; status: string; updatedAt: Date; errorMessage: string | null }

function fakeModel(rows: Job[]) {
  return {
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((j) => j.status === where.status && j.updatedAt < where.updatedAt.lt);
      for (const j of hit) Object.assign(j, data);
      return { count: hit.length };
    },
  };
}

describe('VoiceReplyReaperService', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('КЛЮЧЕВОЙ ТЕСТ: PENDING старше 30 мин и PROCESSING старше 5 мин → FAILED с причиной; свежие и терминальные не трогаются', async () => {
    const sparring: Job[] = [
      { id: 's-old-pending', status: 'PENDING', updatedAt: ago(VOICE_REPLY_PENDING_MAX_AGE_MS + 1000), errorMessage: null },
      { id: 's-fresh-pending', status: 'PENDING', updatedAt: ago(60_000), errorMessage: null },
      { id: 's-old-processing', status: 'PROCESSING', updatedAt: ago(VOICE_REPLY_PROCESSING_MAX_AGE_MS + 1000), errorMessage: null },
      { id: 's-fresh-processing', status: 'PROCESSING', updatedAt: ago(30_000), errorMessage: null },
      { id: 's-done', status: 'COMPLETED', updatedAt: ago(10 * 60 * 60 * 1000), errorMessage: null },
    ];
    const material: Job[] = [
      { id: 'm-old-pending', status: 'PENDING', updatedAt: ago(VOICE_REPLY_PENDING_MAX_AGE_MS + 1000), errorMessage: null },
    ];
    const prisma = { sparringVoiceReplyJob: fakeModel(sparring), materialChatVoiceReplyJob: fakeModel(material) };
    const reaper = new VoiceReplyReaperService(prisma as any);

    const result = await reaper.reapStale(now);

    expect(result).toEqual({ voiceRepliesReaped: 3 });
    const byId = Object.fromEntries([...sparring, ...material].map((j) => [j.id, j]));
    expect(byId['s-old-pending'].status).toBe('FAILED');
    expect(byId['s-old-pending'].errorMessage).toMatch(/результат от провайдера так и не пришёл/);
    expect(byId['s-old-processing'].status).toBe('FAILED');
    expect(byId['s-old-processing'].errorMessage).toMatch(/обработка прервалась/);
    expect(byId['m-old-pending'].status).toBe('FAILED');
    // PENDING моложе получаса и PROCESSING моложе пяти минут — ещё в работе.
    expect(byId['s-fresh-pending'].status).toBe('PENDING');
    expect(byId['s-fresh-processing'].status).toBe('PROCESSING');
    expect(byId['s-done'].status).toBe('COMPLETED');
  });

  it('пустая база — ноль, без ошибок', async () => {
    const prisma = { sparringVoiceReplyJob: fakeModel([]), materialChatVoiceReplyJob: fakeModel([]) };
    expect(await new VoiceReplyReaperService(prisma as any).reapStale(now)).toEqual({ voiceRepliesReaped: 0 });
  });
});
