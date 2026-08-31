import { ForbiddenException, BadGatewayException } from '@nestjs/common';
import { YouTubeSearchService } from '../media-review/youtube-search.service';

function createFakePrisma() {
  const logs: any[] = [];
  let idCounter = 0;
  return {
    _seedLogs(userId: string, count: number, hoursAgo = 1) {
      for (let i = 0; i < count; i++) {
        logs.push({ id: `log-${++idCounter}`, userId, createdAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) });
      }
    },
    youTubeSearchLog: {
      count: async ({ where }: any) => {
        return logs.filter(
          (l) => l.userId === where.userId && l.createdAt.getTime() >= where.createdAt.gte.getTime(),
        ).length;
      },
      create: async ({ data }: any) => {
        const log = { id: `log-${++idCounter}`, createdAt: new Date(), ...data };
        logs.push(log);
        return log;
      },
    },
  };
}

function createFakeSecrets(apiKey = 'test-youtube-key') {
  return { resolve: async (_ref: string) => apiKey } as any;
}

describe('YouTubeSearchService', () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('отклоняет поиск при достижении дневного лимита (§5 ТЗ)', async () => {
    const prisma = createFakePrisma();
    prisma._seedLogs('u1', 20); // ровно лимит
    const service = new YouTubeSearchService(prisma as any, createFakeSecrets());

    await expect(service.search('u1', 'test query')).rejects.toThrow(ForbiddenException);
  });

  it('не считает попытки старше 24 часов в лимите', async () => {
    const prisma = createFakePrisma();
    prisma._seedLogs('u1', 20, 25); // все старше суток
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('/search')) {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    });
    const service = new YouTubeSearchService(prisma as any, createFakeSecrets());

    await expect(service.search('u1', 'test query')).resolves.toEqual([]);
  });

  it('возвращает только метаданные — videoId/title/channelName/thumbnailUrl/duration/publishedAt, без содержимого видео', async () => {
    const prisma = createFakePrisma();
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('/search')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: { videoId: 'abc123' },
                snippet: {
                  title: 'Test video',
                  channelTitle: 'Test Channel',
                  publishedAt: '2026-01-01T00:00:00Z',
                  thumbnails: { medium: { url: 'https://example.com/thumb.jpg' } },
                },
              },
            ],
          }),
        };
      }
      // videos.list
      return {
        ok: true,
        json: async () => ({ items: [{ id: 'abc123', contentDetails: { duration: 'PT10M30S' } }] }),
      };
    });
    const service = new YouTubeSearchService(prisma as any, createFakeSecrets());

    const results = await service.search('u1', 'test query');

    expect(results).toEqual([
      {
        videoId: 'abc123',
        title: 'Test video',
        channelName: 'Test Channel',
        thumbnailUrl: 'https://example.com/thumb.jpg',
        durationSeconds: 630,
        publishedAt: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('честно деградирует, если videos.list (тривалість) недоступний — не роняет весь пошук', async () => {
    const prisma = createFakePrisma();
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('/search')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: { videoId: 'abc123' },
                snippet: {
                  title: 'Test video',
                  channelTitle: 'Test Channel',
                  publishedAt: '2026-01-01T00:00:00Z',
                  thumbnails: { default: { url: 'https://example.com/thumb-default.jpg' } },
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    const service = new YouTubeSearchService(prisma as any, createFakeSecrets());

    const results = await service.search('u1', 'test query');

    expect(results[0].durationSeconds).toBeNull();
    expect(results[0].thumbnailUrl).toBe('https://example.com/thumb-default.jpg');
  });

  it('пробрасывает BadGatewayException при ошибке search.list (например исчерпана квота)', async () => {
    const prisma = createFakePrisma();
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 403 }));
    const service = new YouTubeSearchService(prisma as any, createFakeSecrets());

    await expect(service.search('u1', 'test query')).rejects.toThrow(BadGatewayException);
  });

  it('записывает лог попытки поиска даже при ошибке ответа (Google считает квоту за любой вызов)', async () => {
    const prisma = createFakePrisma();
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 403 }));
    const service = new YouTubeSearchService(prisma as any, createFakeSecrets());

    await expect(service.search('u1', 'test query')).rejects.toThrow();
    const count = await prisma.youTubeSearchLog.count({ where: { userId: 'u1', createdAt: { gte: new Date(0) } } });
    expect(count).toBe(1);
  });
});
