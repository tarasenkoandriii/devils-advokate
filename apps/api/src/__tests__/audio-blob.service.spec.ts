// Пункт [blob-upload] 2026-08-31 — тесты прямой загрузки аудио в
// приватный Vercel Blob.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ЧТО НЕТ, честно. Сам SDK замокан: живого
// blob-стора в этой среде нет, и тест, который «проверял» бы сетевой
// вызов, проверял бы только мою же заглушку. Поэтому проверяется
// граница НАШЕЙ ответственности — то, что при неверном коде ломается
// тихо и опасно:
//   • токен на запись не выдаётся без согласий и не своему разговору
//     (иначе повторяется дыра «upload без transcribe», найденная
//     повторным аудитом 2026-08-30 в streamUploadAudio);
//   • ограничения размера и типа уходят В ТОКЕН, а не остаются
//     пожеланием на клиенте;
//   • подтверждение загрузки не верит клиенту на слово;
//   • удаление снимает ссылку в БД, а не только зовёт del().

import { ForbiddenException, NotFoundException } from '@nestjs/common';

const mockHead = jest.fn();
const mockDel = jest.fn();
const mockIssueSignedToken = jest.fn();
const mockPresignUrl = jest.fn();
const mockHandleUpload = jest.fn();

jest.mock('@vercel/blob', () => ({
  head: (...args: unknown[]) => mockHead(...args),
  del: (...args: unknown[]) => mockDel(...args),
  issueSignedToken: (...args: unknown[]) => mockIssueSignedToken(...args),
  presignUrl: (...args: unknown[]) => mockPresignUrl(...args),
}));

jest.mock('@vercel/blob/client', () => ({
  handleUpload: (...args: unknown[]) => mockHandleUpload(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { AudioBlobService } from '../conversations/audio-blob.service';

const USER_ID = 'user-1';
const OTHER_USER = 'user-2';
const CONV_ID = 'conv-1';
const PATHNAME = 'conversation-audio/conv-1/rec.m4a';

function makeDeps(overrides: { ownerId?: string; audioBlobPathname?: string | null } = {}) {
  const updates: any[] = [];
  const prisma = {
    conversation: {
      findUnique: jest.fn(async () => ({
        id: CONV_ID,
        projectId: 'proj-1',
        audioBlobPathname: overrides.audioBlobPathname ?? null,
        project: { id: 'proj-1', ownerId: overrides.ownerId ?? USER_ID },
      })),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return { id: CONV_ID, ...args.data };
      }),
    },
    _updates: updates,
  };
  const secrets = { resolve: jest.fn(async () => 'vercel_blob_rw_FAKE') };
  const consent = { assertAudioMayLeaveDevice: jest.fn(async () => undefined) };
  return { prisma, secrets, consent };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new AudioBlobService(deps.prisma as any, deps.secrets as any, deps.consent as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHandleUpload.mockImplementation(async (opts: any) => {
    // Прогоняем onBeforeGenerateToken так же, как это делает настоящий
    // SDK на событии blob.generate-client-token — иначе проверки внутри
    // него никогда бы не выполнились, и тест «согласия проверяются»
    // проходил бы на коде, где их нет.
    const payload = await opts.onBeforeGenerateToken(PATHNAME, null, false);
    return { type: 'blob.generate-client-token', clientToken: 'tok', _payload: payload };
  });
});

describe('AudioBlobService.issueUploadToken', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: без согласий токен на запись не выдаётся', async () => {
    const deps = makeDeps();
    deps.consent.assertAudioMayLeaveDevice.mockRejectedValueOnce(
      new ForbiddenException('Consent required: RECORDING'),
    );
    const svc = makeService(deps);

    await expect(svc.issueUploadToken(USER_ID, CONV_ID, {} as any, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чужой разговор — NotFound, токен не выдаётся', async () => {
    const deps = makeDeps({ ownerId: OTHER_USER });
    const svc = makeService(deps);

    await expect(svc.issueUploadToken(USER_ID, CONV_ID, {} as any, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.consent.assertAudioMayLeaveDevice).not.toHaveBeenCalled();
  });

  it('ограничения размера и типа попадают В ТОКЕН, а не остаются на клиенте', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const result: any = await svc.issueUploadToken(USER_ID, CONV_ID, {} as any, {});

    // Именно эти поля Vercel применяет на своей стороне при записи —
    // клиент не может их обойти, подменив что-то у себя.
    expect(result._payload.maximumSizeInBytes).toBe(500 * 1024 * 1024);
    expect(result._payload.allowedContentTypes).toEqual(['audio/*', 'video/*', 'application/octet-stream']);
    expect(result._payload.addRandomSuffix).toBe(true);
    expect(result._payload.allowOverwrite).toBe(false);
    expect(result._payload.validUntil).toBeGreaterThan(Date.now());
  });
});

describe('AudioBlobService.issueUploadToken — префикс pathname', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: pathname вне conversation-audio/ не получает токен вовсе', async () => {
    const deps = makeDeps();
    mockHandleUpload.mockImplementation(async (opts: any) => {
      // Настоящий SDK передал бы pathname из запроса клиента — здесь
      // клиент просит токен на чужой префикс стора.
      const payload = await opts.onBeforeGenerateToken('dtp-evidence/чужое.jpg', null, false);
      return { type: 'blob.generate-client-token', clientToken: 'tok', _payload: payload };
    });
    const svc = makeService(deps);

    await expect(svc.issueUploadToken(USER_ID, CONV_ID, {} as any, {})).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AudioBlobService.confirmUpload', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: размер берётся из хранилища, а не со слов клиента', async () => {
    const deps = makeDeps();
    mockHead.mockResolvedValueOnce({ size: 12345, contentType: 'audio/mp4', pathname: PATHNAME });
    const svc = makeService(deps);

    const res = await svc.confirmUpload(USER_ID, CONV_ID, { pathname: PATHNAME });

    expect(mockHead).toHaveBeenCalledWith(PATHNAME, { token: 'vercel_blob_rw_FAKE' });
    expect(res.sizeBytes).toBe(12345);
    expect(deps.prisma._updates[0].data).toEqual({
      audioBlobPathname: PATHNAME,
      audioBlobBytes: 12345,
      // Пункт [multimodal]: MIME-тип — тоже из head() у стора, не со
      // слов клиента; нужен MediaRef'у паралингвистики.
      audioBlobContentType: 'audio/mp4',
    });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: pathname вне нашего префикса отвергается', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await expect(
      svc.confirmUpload(USER_ID, CONV_ID, { pathname: 'dtp-evidence/чужой-файл.jpg' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockHead).not.toHaveBeenCalled();
  });

  it('файла нет в сторе — NotFound, ссылка в БД не появляется', async () => {
    const deps = makeDeps();
    mockHead.mockRejectedValueOnce(new Error('not found'));
    const svc = makeService(deps);

    await expect(svc.confirmUpload(USER_ID, CONV_ID, { pathname: PATHNAME })).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.prisma._updates).toHaveLength(0);
  });

  it('повторная загрузка другого файла удаляет предыдущий, а не копит мусор', async () => {
    const deps = makeDeps({ audioBlobPathname: 'conversation-audio/conv-1/старый.m4a' });
    mockHead.mockResolvedValueOnce({ size: 10, contentType: 'audio/mp4', pathname: PATHNAME });
    const svc = makeService(deps);

    await svc.confirmUpload(USER_ID, CONV_ID, { pathname: PATHNAME });

    expect(mockDel).toHaveBeenCalledWith('conversation-audio/conv-1/старый.m4a', { token: 'vercel_blob_rw_FAKE' });
  });

  it('согласия проверяются и на подтверждении — не только при выдаче токена', async () => {
    const deps = makeDeps();
    deps.consent.assertAudioMayLeaveDevice.mockRejectedValueOnce(new ForbiddenException('Consent required'));
    const svc = makeService(deps);

    await expect(svc.confirmUpload(USER_ID, CONV_ID, { pathname: PATHNAME })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AudioBlobService.presignForTranscription', () => {
  it('подписывает ссылку только на чтение и с ограниченным сроком', async () => {
    const deps = makeDeps();
    mockIssueSignedToken.mockResolvedValueOnce({
      delegationToken: 'dt', clientSigningToken: 'cst', validUntil: Date.now() + 1000,
    });
    mockPresignUrl.mockResolvedValueOnce({ presignedUrl: 'https://blob/signed' });
    const svc = makeService(deps);

    const url = await svc.presignForTranscription(PATHNAME);

    expect(url).toBe('https://blob/signed');
    const issueArgs = mockIssueSignedToken.mock.calls[0][0];
    // 'get' и ничего больше: подписанная ссылка, которой можно ПЕРЕЗАПИСАТЬ
    // или удалить файл, — это уже не «ссылка для провайдера».
    expect(issueArgs.operations).toEqual(['get']);
    expect(issueArgs.pathname).toBe(PATHNAME);
    expect(issueArgs.validUntil).toBeGreaterThan(Date.now());

    const presignArgs = mockPresignUrl.mock.calls[0][1];
    expect(presignArgs.access).toBe('private');
    expect(presignArgs.operation).toBe('get');
  });
});

describe('AudioBlobService.releaseConversationAudio', () => {
  it('удаляет файл И снимает ссылку в БД — инвариант «pathname есть ⇒ файл есть»', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.releaseConversationAudio(CONV_ID, PATHNAME);

    expect(mockDel).toHaveBeenCalledWith(PATHNAME, { token: 'vercel_blob_rw_FAKE' });
    expect(deps.prisma._updates[0].data).toEqual({ audioBlobPathname: null, audioBlobBytes: null });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сбой удаления НЕ роняет обработку — иначе потеряется уже полученный транскрипт', async () => {
    const deps = makeDeps();
    mockDel.mockRejectedValueOnce(new Error('blob store unavailable'));
    const svc = makeService(deps);

    await expect(svc.releaseConversationAudio(CONV_ID, PATHNAME)).resolves.toBeUndefined();
    // Ссылка всё равно снимается: файл, который не удалось удалить,
    // чинится чисткой стора, а «в БД висит путь к файлу, который мы
    // считаем удалённым» — вводит в заблуждение и пользователя, и
    // следующего разработчика.
    expect(deps.prisma._updates[0].data).toEqual({ audioBlobPathname: null, audioBlobBytes: null });
  });

  it('pathname отсутствует — ничего не делает (разговор загружали старым потоковым путём)', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.releaseConversationAudio(CONV_ID, null);

    expect(mockDel).not.toHaveBeenCalled();
    expect(deps.prisma._updates).toHaveLength(0);
  });
});
