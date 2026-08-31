// Пункт [admin-sandbox] 2026-08-31 — тесты песочницы оператора.
//
// Главное, что здесь проверяется, — ГРАНИЦЫ, а не счастливый путь:
// песочница выполняет реальные платные операции, и ошибка в её
// авторизации или в утечке секретов стоила бы дороже, чем сломанная
// кнопка. Плюс WAV-генератор: битый заголовок дал бы «error» от
// AssemblyAI, неотличимый от реальной проблемы конфигурации — то есть
// песочница ЛГАЛА бы про исправную цепочку.

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminSandboxService, makeSandboxWav } from '../admin-sandbox/admin-sandbox.service';

const OPERATOR = 'op-1';
const REGULAR = 'user-2';

function makeDeps(overrides: { operator?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        isOperator: where.id === OPERATOR ? overrides.operator !== false : false,
        privacyProcessingMode: 'BALANCED',
      })),
      count: jest.fn(async () => 3),
    },
    aIProvider: {
      count: jest.fn(async () => 4),
      findUnique: jest.fn(async () => ({ id: 'p1', name: 'assemblyai' })),
    },
    project: {
      findFirst: jest.fn(async (): Promise<{ id: string } | null> => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'proj-sandbox', ...data })),
    },
  };
  const secrets = {
    resolve: jest.fn(async (ref: string) => {
      if (ref === 'YOUTUBE_API_KEY' || ref === 'ASSEMBLYAI_API_KEY') return 'SUPERSECRET-VALUE-42';
      throw new Error(`Secret not found for credentialRef "${ref}"`);
    }),
  };
  const consent = {
    hasActiveConsent: jest.fn(async (_u: string, _type: string) => false),
    grant: jest.fn(async () => ({})),
  };
  const conversations = {
    create: jest.fn(async () => ({ id: 'conv-1' })),
    streamUploadAudio: jest.fn(async () => ({ audioUrl: 'https://cdn/upload' })),
    requestTranscription: jest.fn(async () => ({ status: 'TRANSCRIBING', externalTranscriptionJobId: 'job-1' })),
    get: jest.fn(async () => ({
      id: 'conv-1', status: 'TRANSCRIBED', externalTranscriptionJobId: 'job-1',
      transcript: { segments: [] }, participants: [], updatedAt: new Date(),
    })),
  };
  const youtube = { search: jest.fn(async () => [{ videoId: 'v1' }]) };
  const manipulation = { detect: jest.fn(async () => ({ kind: 'manip' })) };
  const discrepancy = { detect: jest.fn(async () => ({ kind: 'disc' })) };
  const turningPoints = { detect: jest.fn(async () => ({ kind: 'tp' })) };
  return { prisma, secrets, consent, conversations, youtube, manipulation, discrepancy, turningPoints };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new AdminSandboxService(
    deps.prisma as any,
    deps.secrets as any,
    deps.consent as any,
    deps.conversations as any,
    deps.youtube as any,
    deps.manipulation as any,
    deps.discrepancy as any,
    deps.turningPoints as any,
  );
}

describe('AdminSandboxService — граница по роли', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: без isOperator ни один метод не работает', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await expect(svc.getStatus(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.grantOwnConsents(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.youtubeSearch(REGULAR, 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.runTranscriptionSmoke(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getConversation(REGULAR, 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.analyze(REGULAR, 'conv-1', 'manipulation')).rejects.toBeInstanceOf(ForbiddenException);
    // Ни платных вызовов, ни выдачи согласий не произошло.
    expect(deps.youtube.search).not.toHaveBeenCalled();
    expect(deps.consent.grant).not.toHaveBeenCalled();
    expect(deps.conversations.streamUploadAudio).not.toHaveBeenCalled();
  });
});

describe('AdminSandboxService.getStatus', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: в ответе нет значений секретов — только задан/не задан', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const { items } = await svc.getStatus(OPERATOR);
    const dump = JSON.stringify(items);
    // 'SUPERSECRET-VALUE-42' — значение, которое мок резолвит для
    // заданных ключей. Проверка от противного: если кто-то начнёт
    // класть значение секрета в detail, тест поймает это на самом
    // дешёвом уровне.
    expect(dump).not.toContain('SUPERSECRET-VALUE-42');
  });

  it('отражает и заданные, и незаданные ключи', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const { items } = await svc.getStatus(OPERATOR);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['youtube'].ok).toBe(true);
    expect(byKey['assemblyai'].ok).toBe(true);
    expect(byKey['webhook-secret'].ok).toBe(false);
    expect(byKey['llm'].ok).toBe(false);
    expect(byKey['seed'].ok).toBe(true);
    expect(byKey['consents'].ok).toBe(false); // hasActiveConsent → false
  });
});

describe('AdminSandboxService.grantOwnConsents', () => {
  it('выдаёт только недостающие согласия и помечает источник admin-sandbox', async () => {
    const deps = makeDeps();
    deps.consent.hasActiveConsent = jest.fn(async (_u: string, type: string) => type === 'RECORDING');
    const svc = makeService(deps);

    const res = await svc.grantOwnConsents(OPERATOR);

    expect(res.granted.sort()).toEqual(['EPHEMERAL_SERVER', 'EXTERNAL_AI']);
    expect(res.alreadyHad).toEqual(['RECORDING']);
    for (const call of (deps.consent.grant as jest.Mock).mock.calls) {
      expect(call[0].source).toBe('admin-sandbox');
      expect(call[0].userId).toBe(OPERATOR); // только себе, никакой имперсонации
    }
  });
});

describe('AdminSandboxService.youtubeSearch', () => {
  it('делегирует в реальный YouTubeSearchService с userId оператора (лимит 20/сутки не обходится)', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.youtubeSearch(OPERATOR, '  дебаты  ');

    expect(deps.youtube.search).toHaveBeenCalledWith(OPERATOR, 'дебаты');
  });

  it('пустой запрос — отказ до обращения к API (квота тратится даже на ошибку)', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await expect(svc.youtubeSearch(OPERATOR, '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.youtube.search).not.toHaveBeenCalled();
  });
});

describe('AdminSandboxService.runTranscriptionSmoke', () => {
  it('идёт через продовые методы ConversationsService — проверки согласий не обходятся', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const res = await svc.runTranscriptionSmoke(OPERATOR);

    expect(deps.conversations.streamUploadAudio).toHaveBeenCalled();
    expect((deps.conversations.streamUploadAudio as jest.Mock).mock.calls[0][0]).toBe(OPERATOR);
    expect(deps.conversations.requestTranscription).toHaveBeenCalledWith(OPERATOR, 'conv-1', {
      audioUrl: 'https://cdn/upload',
    });
    expect(res.conversationId).toBe('conv-1');
    expect(res.status).toBe('TRANSCRIBING');
  });

  it('отказ по согласиям пробрасывается как есть — это результат прогона, не сбой песочницы', async () => {
    const deps = makeDeps();
    deps.conversations.streamUploadAudio = jest.fn(async () => {
      throw new ForbiddenException('Consent required: RECORDING');
    });
    const svc = makeService(deps);

    await expect(svc.runTranscriptionSmoke(OPERATOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.conversations.requestTranscription).not.toHaveBeenCalled();
  });

  it('переиспользует существующий песочный проект, а не создаёт новый на каждый прогон', async () => {
    const deps = makeDeps();
    deps.prisma.project.findFirst = jest.fn(async () => ({ id: 'proj-existing' }));
    const svc = makeService(deps);

    const res = await svc.runTranscriptionSmoke(OPERATOR);

    expect(deps.prisma.project.create).not.toHaveBeenCalled();
    expect(res.projectId).toBe('proj-existing');
  });
});

describe('AdminSandboxService.analyze', () => {
  it('переключает на нужный детектор и не трогает остальные', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.analyze(OPERATOR, 'conv-1', 'discrepancy');

    expect(deps.discrepancy.detect).toHaveBeenCalledWith(OPERATOR, 'conv-1');
    expect(deps.manipulation.detect).not.toHaveBeenCalled();
    expect(deps.turningPoints.detect).not.toHaveBeenCalled();
  });

  it('неизвестный вид анализа — BadRequest, а не тихий no-op', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    await expect(svc.analyze(OPERATOR, 'conv-1', 'nonsense' as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('makeSandboxWav', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: корректный WAV-заголовок — битый файл маскировал бы проблемы конфигурации под «error» провайдера', () => {
    const wav = makeSandboxWav();

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // моно
    expect(wav.readUInt32LE(24)).toBe(8000); // sample rate
    // RIFF-размер согласован с реальной длиной буфера — рассинхрон
    // здесь и есть «битый файл».
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    // 3 секунды при 8кГц 16-бит моно.
    expect(wav.length - 44).toBe(8000 * 3 * 2);
  });

  it('в сигнале есть ненулевые сэмплы (не тишина) и нет клиппинга', () => {
    const wav = makeSandboxWav();
    let max = 0;
    for (let i = 44; i < wav.length; i += 2) {
      max = Math.max(max, Math.abs(wav.readInt16LE(i)));
    }
    expect(max).toBeGreaterThan(1000);
    expect(max).toBeLessThanOrEqual(32767);
  });
});
