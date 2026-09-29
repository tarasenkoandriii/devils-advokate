// Аудит удаления 2026-09-03 — «данные, которые пользователь считает
// удалёнными»: кэши, адресуемые содержимым, а не пользователем.
//
// Оба кэша (озвучка и ответы фактчека) хранят текст человека и не связаны
// с ним ключом — значит удаление аккаунта, удаление проекта и отзыв
// согласий их не касаются в принципе. Единственный механизм удаления для
// такой строки — срок жизни, и тесты держат именно его.
import { CacheRetentionService, TTS_CACHE_TTL_MS } from '../privacy-center/cache-retention.service';

function createFakePrisma() {
  const tts: Array<{ id: string; createdAt: Date }> = [];
  const factCheck: Array<{ id: string; expiresAt: Date }> = [];
  return {
    _tts: tts,
    _factCheck: factCheck,
    ttsCache: {
      deleteMany: async ({ where }: any) => {
        const before = tts.length;
        const keep = tts.filter((r) => !(r.createdAt < where.createdAt.lt));
        tts.length = 0;
        tts.push(...keep);
        return { count: before - tts.length };
      },
    },
    factCheckApiCache: {
      deleteMany: async ({ where }: any) => {
        const before = factCheck.length;
        const keep = factCheck.filter((r) => !(r.expiresAt < where.expiresAt.lt));
        factCheck.length = 0;
        factCheck.push(...keep);
        return { count: before - factCheck.length };
      },
    },
  };
}

describe('CacheRetentionService — у кэша содержимого есть срок жизни, иначе он архив', () => {
  const NOW = new Date('2026-09-03T12:00:00Z');

  it('КЛЮЧЕВОЙ ТЕСТ: озвучка старше срока удаляется, свежая остаётся', async () => {
    const prisma = createFakePrisma();
    prisma._tts.push({ id: 'старая', createdAt: new Date(NOW.getTime() - TTS_CACHE_TTL_MS - 1000) });
    prisma._tts.push({ id: 'свежая', createdAt: new Date(NOW.getTime() - 60_000) });
    const svc = new CacheRetentionService(prisma as any);

    const res = await svc.sweep(NOW);
    expect(res.ttsCacheReaped).toBe(1);
    expect(prisma._tts.map((r) => r.id)).toEqual(['свежая']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: протухший ответ фактчека удаляется, а не просто игнорируется при чтении', async () => {
    // До этого аудита истёкшая запись оставалась в базе навсегда: код
    // проверял expiresAt при чтении и молча шёл в API заново, а строка с
    // текстом продолжала лежать.
    const prisma = createFakePrisma();
    prisma._factCheck.push({ id: 'протух', expiresAt: new Date(NOW.getTime() - 1000) });
    prisma._factCheck.push({ id: 'живой', expiresAt: new Date(NOW.getTime() + 60_000) });
    const svc = new CacheRetentionService(prisma as any);

    const res = await svc.sweep(NOW);
    expect(res.factCheckCacheReaped).toBe(1);
    expect(prisma._factCheck.map((r) => r.id)).toEqual(['живой']);
  });

  it('пустая база — ноль удалений и никаких исключений: сторожевая идёт каждым тиком', async () => {
    const svc = new CacheRetentionService(createFakePrisma() as any);
    expect(await svc.sweep(NOW)).toEqual({ ttsCacheReaped: 0, factCheckCacheReaped: 0 });
  });

  it('срок жизни озвучки назначен месяцем — не «навсегда» и не «до конца сессии»', () => {
    expect(TTS_CACHE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
