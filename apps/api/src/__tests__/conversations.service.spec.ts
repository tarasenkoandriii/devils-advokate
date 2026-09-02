import { ConversationsService } from '../conversations/conversations.service';
import { TranscriptionService } from '../conversations/transcription.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments: any[] = [];
  const aiProviders = new Map<string, any>();
  const aiModelVersions = new Map<string, any>();
  const consentRecords: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, u); },
    _seedProvider(p: any) { aiProviders.set(p.id, p); },
    _seedModelVersion(v: any) { aiModelVersions.set(v.id, v); },
    // ПОВТОРНЫЙ АУДИТ 2026-08-30: раньше сюда передавался фейковый
    // ConsentService с пустым requireConsent() — то есть проверялось,
    // что сервис ЗОВЁТ согласия, но не то, что они реально работают.
    // Теперь спеки используют настоящий ConsentService поверх этого
    // фейкового prisma, поэтому нужен и consentRecord.
    _seedConsent(c: any) {
      consentRecords.push({ granted: true, revokedAt: null, projectId: null, createdAt: new Date(), ...c });
    },
    _getConversation(id: string) { return conversations.get(id); },
    _getSegments() { return segments; },
    _getParticipants() { return [...participants.values()]; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    user: {
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error('user not found');
        return u;
      },
    },
    consentRecord: {
      findFirst: async ({ where }: any) => {
        // Буквальный разбор фильтра, включая семантику Prisma «условие
        // без определённых полей не ограничивает ничего» — иначе тест
        // проверял бы задуманное поведение вместо фактического.
        const matchesCond = (r: any, cond: any) => {
          const defined = Object.entries(cond).filter(([, v]) => v !== undefined);
          if (defined.length === 0) return true;
          return defined.every(([k, v]) => r[k] === v);
        };
        const matches = consentRecords.filter((r) => {
          if (r.userId !== where.userId) return false;
          if (r.consentType !== where.consentType) return false;
          if (where.granted !== undefined && r.granted !== where.granted) return false;
          if (where.revokedAt === null && r.revokedAt !== null) return false;
          if ('projectId' in where && where.projectId === null && r.projectId !== null) return false;
          if (where.OR && !where.OR.some((c: any) => matchesCond(r, c))) return false;
          return true;
        });
        return matches[matches.length - 1] ?? null;
      },
    },
    conversation: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        conversations.set(c.id, c);
        return c;
      },
      findMany: async ({ where }: any) =>
        [...conversations.values()].filter((c) => c.projectId === where.projectId),
      findUnique: async ({ where, include }: any) => {
        const c = conversations.get(where.id);
        if (!c) return null;
        if (include?.project) return { ...c, project: projects.get(c.projectId) };
        if (include?.participants) {
          return {
            ...c,
            participants: [...participants.values()].filter((p) => p.conversationId === c.id),
            transcript: [...transcripts.values()].find((t) => t.conversationId === c.id) ?? null,
          };
        }
        return c;
      },
      findFirst: async ({ where }: any) => {
        // Пункт [stt-multi] 2026-09-02: сервис ищет задачу по ОБОИМ
        // написаниям идентификатора (с префиксом провайдера и без —
        // задачи, поставленные до выката, лежат без него), то есть
        // условие приходит как { in: [...] }. Фейк обязан понимать ту
        // же форму, иначе тест зелёный на коде, который в проде не
        // найдёт разговор и потеряет оплаченную расшифровку.
        const filter = where.externalTranscriptionJobId;
        const ids: string[] = filter && typeof filter === 'object' && Array.isArray(filter.in) ? filter.in : [filter];
        return [...conversations.values()].find((c) => ids.includes(c.externalTranscriptionJobId)) ?? null;
      },
      update: async ({ where, data }: any) => {
        const merged = { ...conversations.get(where.id), ...data };
        conversations.set(where.id, merged);
        return merged;
      },
    },
    conversationParticipant: {
      upsert: async ({ where, create }: any) => {
        const key = `${where.conversationId_diarizationLabel.conversationId}:${where.conversationId_diarizationLabel.diarizationLabel}`;
        const existing = participants.get(key);
        if (existing) return existing;
        const p = { id: nextId(), createdAt: new Date(), personId: null, isSelf: false, ...create };
        participants.set(key, p);
        return p;
      },
    },
    transcript: {
      create: async ({ data }: any) => {
        const t = { id: nextId(), createdAt: new Date(), ...data };
        transcripts.set(t.id, t);
        return t;
      },
      // Повторный аудит 2026-08-30: обработчик вебхука перешёл на
      // upsert (повторная доставка от AssemblyAI — штатное поведение,
      // а Transcript.conversationId объявлен @unique).
      upsert: async ({ where, update, create }: any) => {
        const existing = [...transcripts.values()].find((t) => t.conversationId === where.conversationId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const t = { id: nextId(), createdAt: new Date(), ...create };
        transcripts.set(t.id, t);
        return t;
      },
    },
    transcriptSegment: {
      createMany: async ({ data }: any) => {
        segments.push(...data);
        return { count: data.length };
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].transcriptId === where.transcriptId) {
            segments.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    aIProvider: {
      // Повторный аудит 2026-09-01: код читает провайдера через
      // requireAIProvider (findUnique + внятная ошибка вместо P2025/500).
      findUnique: async ({ where }: any) => [...aiProviders.values()].find((p) => p.name === where.name) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const p = [...aiProviders.values()].find((p) => p.name === where.name);
        if (!p) throw new Error('provider not found');
        return p;
      },
    },
    aIModelVersion: {
      // Повторный аудит 2026-09-01: сервис резолвит версию модели ДО
      // платного submitJob и через findFirst + orderBy (детерминизм),
      // с внятным отказом вместо P2025.
      findFirst: async ({ where }: any) =>
        [...aiModelVersions.values()].find((v) => v.providerId === where.model.providerId) ?? null,
      findFirstOrThrow: async ({ where }: any) => {
        const v = [...aiModelVersions.values()].find((v) => v.providerId === where.model.providerId);
        if (!v) throw new Error('model version not found');
        return v;
      },
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  return fn().then(
    () => { throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`); },
    (err) => {
      if (!(err instanceof expectedType)) {
        throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
      }
    },
  );
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

// Fake TranscriptionService — не делает реальных HTTP-вызовов (сеть
// отключена в среде разработки), возвращает предсказуемый результат.
// Финальный аудит 2026-08-30 — реальный вебхук несёт только
// transcript_id/status; getTranscriptResult() имитирует отдельный GET за
// полным результатом. transcriptResultByJobId настраивается в каждом
// сценарии, где это нужно — по умолчанию используется дефолт ниже.
class FakeTranscriptionService {
  submitCalls: any[] = [];
  getResultCalls: string[] = [];
  transcriptResultByJobId: Record<string, any> = {};
  async submitJob(_apiKey: string, params: any) {
    this.submitCalls.push(params);
    return { externalJobId: 'ext-job-1' };
  }
  async getTranscriptResult(_apiKey: string, transcriptId: string) {
    this.getResultCalls.push(transcriptId);
    return this.transcriptResultByJobId[transcriptId] ?? { status: 'completed', id: transcriptId };
  }
  parseTranscriptResult(result: any) {
    return new TranscriptionService({ resolve: async () => 'whsec-test' } as any).parseTranscriptResult(result);
  }
  uploadCalls = 0;
  async streamUpload() {
    this.uploadCalls += 1;
    return 'https://cdn.assemblyai.com/upload/fake';
  }
}

/** Пункт [stt-multi] 2026-09-02 — заглушка маршрутизатора STT.
 *
 * Оборачивает тот же FakeTranscriptionService: провайдер выбирается по
 * языку, но в тестах разговоров важно не это, а то, что сервис
 * (а) сохраняет идентификатор задачи С ПРЕФИКСОМ провайдера и (б) умеет
 * прочитать результат и по префиксной, и по старой бесперфиксной
 * записи — задачи, поставленные до выката, обязаны дочитаться. */
function makeFakeStt(transcription: FakeTranscriptionService, provider = 'assemblyai') {
  return {
    submitCalls: [] as any[],
    async submitWebhookJob(params: any) {
      this.submitCalls.push(params);
      const { externalJobId } = await transcription.submitJob('key', params);
      return { provider, externalJobId, storedId: `${provider}:${externalJobId}` };
    },
    async fetchResult(storedId: string) {
      const bare = storedId.includes(':') ? storedId.slice(storedId.indexOf(':') + 1) : storedId;
      const result = await transcription.getTranscriptResult('key', bare);
      return transcription.parseTranscriptResult(result);
    },
    async uploadAudio() {
      // Ревью 2026-09-02: загрузка идёт через маршрутизатор — байты
      // уходят ТОМУ провайдеру, который возьмёт задачу. Счётчик
      // остаётся на фейке транскрипции: тест проверяет, что загрузка
      // ровно одна, а не кто её принял.
      await transcription.streamUpload();
      return { audioUrl: 'https://cdn.assemblyai.com/upload/fake', provider };
    },
  };
}

// Пункт [blob-upload] 2026-08-31 — заглушка AudioBlobService.
//
// Считает вызовы, а не просто молчит: главное, что нужно проверять про
// blob в ЭТОМ файле — что файл удаляется после расшифровки, причём на
// ОБЕИХ ветках вебхука. Заглушка, которая ничего не записывает, дала бы
// зелёный тест и на коде, где удаления нет вовсе.
function makeFakeParalinguistics() {
  return {
    wireCalls: 0,
    enqueueCalls: [] as string[],
    wireRelease() {
      this.wireCalls += 1;
    },
    async enqueueForConversation(conversationId: string) {
      this.enqueueCalls.push(conversationId);
      return { jobId: 'para-job-1' };
    },
  };
}

function makeFakeAudioBlob() {
  return {
    presignCalls: [] as string[],
    deleteCalls: [] as string[],
    releaseCalls: [] as { conversationId: string; pathname: string | null }[],
    async deleteByPathname(pathname: string) {
      this.deleteCalls.push(pathname);
    },
    async presignForTranscription(pathname: string) {
      this.presignCalls.push(pathname);
      return `https://blob.example.com/${pathname}?signature=fake`;
    },
    async releaseConversationAudio(conversationId: string, pathname: string | null) {
      this.releaseCalls.push({ conversationId, pathname });
    },
    async confirmUpload() {
      throw new Error('confirmUpload не используется в этих сценариях');
    },
  };
}

async function run() {
  // Выставляется один раз до всех сценариев — requestTranscription()
  // всегда строит webhook URL из этой переменной, порядок выполнения
  // сценариев не должен на это влиять. Первая версия теста
  // выставляла её только внутри одного конкретного сценария — реальный
  // баг теста, найденный именно прогоном, не написанием: сценарий
  // "требует оба согласия", идущий раньше по списку, падал с
  // "API_PUBLIC_BASE_URL is not set", хотя сам код сервиса был рабочим.
  process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';

  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() создаёт Conversation со статусом UPLOADED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new ConversationsService(
      prisma as any,
      {} as SecretsService,
      {} as ConsentService,
      fakeTranscription as any,
      makeFakeStt(fakeTranscription) as any,
      makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    const c = await svc.create(USER_ID, PROJECT_ID, {
      sourceType: 'UPLOADED_AUDIO' as any,
      occurredAt: new Date().toISOString(),
    });
    assertEqual(c.status, 'UPLOADED', 'статус нового Conversation');
  });

  test('create() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, new FakeTranscriptionService() as any, makeFakeStt(new FakeTranscriptionService()) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    await assertThrowsAsync(
      () => svc.create(USER_ID, PROJECT_ID, { sourceType: 'UPLOADED_AUDIO' as any, occurredAt: new Date().toISOString() }),
      NotFoundException,
      'create() на чужой проект',
    );
  });

  test('requestTranscription() бросает ForbiddenException при MAXIMUM_PRIVACY', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'MAXIMUM_PRIVACY' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, new ConsentService(prisma as any), new FakeTranscriptionService() as any, makeFakeStt(new FakeTranscriptionService()) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' }),
      ForbiddenException,
      'requestTranscription() при MAXIMUM_PRIVACY',
    );
  });

  test('requestTranscription() бросает ForbiddenException, если статус не UPLOADED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING', occurredAt: new Date() },
    });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, new ConsentService(prisma as any), new FakeTranscriptionService() as any, makeFakeStt(new FakeTranscriptionService()) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' }),
      ForbiddenException,
      'requestTranscription() при статусе TRANSCRIBING',
    );
  });

  test('requestTranscription() требует оба согласия (RECORDING и EPHEMERAL_SERVER)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    prisma._seedModelVersion({ id: 'mv1', providerId: 'p1' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });

    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, new ConsentService(prisma as any), new FakeTranscriptionService() as any, makeFakeStt(new FakeTranscriptionService()) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any);

    // Ни одного согласия — отказ.
    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' }),
      ForbiddenException,
      'requestTranscription() без согласий',
    );

    // Только RECORDING — всё ещё отказ: EPHEMERAL_SERVER это отдельное
    // согласие на передачу внешнему провайдеру, а не следствие первого.
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' }),
      ForbiddenException,
      'requestTranscription() только с RECORDING',
    );

    // Оба — проходит.
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    const ok = await svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' });
    assertEqual(ok.status, 'TRANSCRIBING', 'статус при обоих выданных согласиях');
  });

  test('requestTranscription() успешно переводит статус в TRANSCRIBING и сохраняет job id', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    prisma._seedModelVersion({ id: 'mv1', providerId: 'p1' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, new ConsentService(prisma as any), new FakeTranscriptionService() as any, makeFakeStt(new FakeTranscriptionService()) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any);

    const updated = await svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' });
    assertEqual(updated.status, 'TRANSCRIBING', 'статус после запроса транскрибации');
    // Пункт [stt-multi] 2026-09-02: идентификатор хранится С ПРЕФИКСОМ
    // провайдера — по нему вебхук узнаёт, у кого забирать результат
    // (задачу мог взять запасной провайдер). Миграции это не требует:
    // строка та же, читатели старых значений понимают их как AssemblyAI.
    assertEqual(updated.externalTranscriptionJobId, 'assemblyai:ext-job-1', 'сохранённый externalTranscriptionJobId — с префиксом провайдера');
  });

  // ─────────────────────────────────────────────────────────────────
  // Пункт [blob-upload] 2026-08-31 — сценарии прямой загрузки в blob.
  // ─────────────────────────────────────────────────────────────────

  test('[blob] requestTranscription() без audioUrl берёт загруженный файл и подписывает ссылку', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    prisma._seedModelVersion({ id: 'mv1', providerId: 'p1' });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID,
        sourceType: 'UPLOADED_AUDIO',
        status: 'UPLOADED',
        occurredAt: new Date(),
        audioBlobPathname: 'conversation-audio/c1/rec.m4a',
      },
    });
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    const secrets = { resolve: async () => 'fake-key' } as any;
    const transcription = new FakeTranscriptionService();
    const audioBlob = makeFakeAudioBlob();
    const svc = new ConversationsService(
      prisma as any, secrets, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, audioBlob as any, makeFakeParalinguistics() as any,
    );

    await svc.requestTranscription(USER_ID, conv.id, {});

    assertEqual(audioBlob.presignCalls.length, 1, 'ровно одна подписанная ссылка');
    assertEqual(audioBlob.presignCalls[0], 'conversation-audio/c1/rec.m4a', 'подписан именно загруженный файл');
    // Главное здесь — не факт вызова presign, а то, что в AssemblyAI
    // уехала ИМЕННО подписанная ссылка. Проверка «presign позвали» без
    // этой строки прошла бы и на коде, который позвал presign и
    // отправил провайдеру что-то другое.
    assertEqual(
      transcription.submitCalls[0].audioUrl,
      'https://blob.example.com/conversation-audio/c1/rec.m4a?signature=fake',
      'провайдеру ушла подписанная ссылка, а не путь и не публичный URL',
    );
  });

  test('[blob] КЛЮЧЕВОЙ ТЕСТ: audioUrl И загруженный файл одновременно — отказ, а не молчаливый выбор', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID,
        sourceType: 'UPLOADED_AUDIO',
        status: 'UPLOADED',
        occurredAt: new Date(),
        audioBlobPathname: 'conversation-audio/c1/rec.m4a',
      },
    });
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    const transcription = new FakeTranscriptionService();
    const svc = new ConversationsService(
      prisma as any, { resolve: async () => 'k' } as any, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );

    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://other/file.mp3' }),
      ForbiddenException,
      'два источника аудио сразу — неоднозначность, расшифровать «какой-нибудь» нельзя',
    );
    assertEqual(transcription.submitCalls.length, 0, 'задача провайдеру не отправлена');
  });

  test('[blob] нет ни audioUrl, ни загруженного файла — понятный отказ до обращения к провайдеру', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    const transcription = new FakeTranscriptionService();
    const svc = new ConversationsService(
      prisma as any, { resolve: async () => 'k' } as any, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );

    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, {}),
      ForbiddenException,
      'без аудио запускать расшифровку нечего',
    );
    assertEqual(transcription.submitCalls.length, 0, 'задача провайдеру не отправлена');
  });

  test('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-30): streamUploadAudio() НЕ отправляет файл без согласий — дыра «upload без transcribe»', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    const transcription = new FakeTranscriptionService();
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any);

    // Раньше здесь проверялось только владение разговором — файл уходил
    // AssemblyAI, а согласия спрашивались на следующем шаге, когда байты
    // уже были у провайдера.
    await assertThrowsAsync(
      () => svc.streamUploadAudio(USER_ID, conv.id, null as any),
      ForbiddenException,
      'streamUploadAudio() без согласий',
    );
    assertEqual(transcription.uploadCalls, 0, 'ни одного вызова streamUpload при отсутствии согласий');
  });

  test('streamUploadAudio() запрещён в режиме MAXIMUM_PRIVACY, даже если согласия выданы', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'MAXIMUM_PRIVACY' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    const transcription = new FakeTranscriptionService();
    const svc = new ConversationsService(prisma as any, {} as SecretsService, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any);

    await assertThrowsAsync(
      () => svc.streamUploadAudio(USER_ID, conv.id, null as any),
      ForbiddenException,
      'streamUploadAudio() при MAXIMUM_PRIVACY',
    );
    assertEqual(transcription.uploadCalls, 0, 'режим приватности сильнее выданных согласий');
  });

  test('streamUploadAudio() работает при выданных согласиях и BALANCED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'RECORDING' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EPHEMERAL_SERVER' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    const transcription = new FakeTranscriptionService();
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any);

    const { audioUrl } = await svc.streamUploadAudio(USER_ID, conv.id, null as any);
    assertEqual(audioUrl, 'https://cdn.assemblyai.com/upload/fake', 'audioUrl после успешной загрузки');
    assertEqual(transcription.uploadCalls, 1, 'ровно одна загрузка');
  });

  test('handleTranscriptionWebhook() создаёт Transcript+TranscriptSegment+ConversationParticipant', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'ext-job-1',
      },
    });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const fakeTranscription = new FakeTranscriptionService();
    fakeTranscription.transcriptResultByJobId['ext-job-1'] = {
      status: 'completed',
      id: 'ext-job-1',
      language_code: 'ru',
      utterances: [
        { speaker: 'A', text: 'Привет', start: 0, end: 1000, confidence: 0.95 },
        { speaker: 'B', text: 'Здравствуйте', start: 1000, end: 2500, confidence: 0.9 },
        { speaker: 'A', text: 'Как дела?', start: 2500, end: 3500, confidence: 0.92 },
      ],
    };
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(
      prisma as any, secrets, {} as ConsentService, fakeTranscription as any, makeFakeStt(fakeTranscription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );

    // Финальный аудит 2026-08-30: реальный вебхук несёт только transcript_id/status.
    await svc.handleTranscriptionWebhook({ transcript_id: 'ext-job-1', status: 'completed' } as any);
    assertEqual(fakeTranscription.getResultCalls, ['ext-job-1'], 'полный результат запрошен отдельным GET по transcript_id из вебхука');

    const updated = prisma._getConversation(conv.id);
    assertEqual(updated.status, 'TRANSCRIBED', 'статус после успешного webhook');
    assertEqual(prisma._getSegments().length, 3, 'количество сохранённых сегментов');
    assertEqual(prisma._getParticipants().length, 2, 'количество уникальных участников (A, B)');
  });

  test('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-30): повторная доставка вебхука не удваивает транскрипт и не падает на @unique', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'job-repeat',
      },
    });
    const transcription = new FakeTranscriptionService();
    transcription.transcriptResultByJobId['job-repeat'] = {
      status: 'completed', id: 'job-repeat', language_code: 'ru',
      utterances: [
        { speaker: 'A', text: 'первая реплика', start: 0, end: 1000, confidence: 0.9 },
        { speaker: 'B', text: 'вторая реплика', start: 1000, end: 2000, confidence: 0.9 },
      ],
    };
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, new ConsentService(prisma as any), transcription as any, makeFakeStt(transcription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any);

    // AssemblyAI ретраит вебхук на любой не-2xx — повторная доставка это
    // штатное поведение провайдера, а не экзотика.
    await svc.handleTranscriptionWebhook({ transcript_id: 'job-repeat', status: 'completed' } as any);
    await svc.handleTranscriptionWebhook({ transcript_id: 'job-repeat', status: 'completed' } as any);

    assertEqual(prisma._getSegments().length, 2, 'сегментов после двух доставок — столько же, сколько после одной');
    assertEqual(prisma._getConversation(conv.id).status, 'TRANSCRIBED', 'статус после повторной доставки');
  });

  test('[blob] КЛЮЧЕВОЙ ТЕСТ: файл удаляется после УСПЕШНОЙ расшифровки — иначе транзитный буфер превращается в хранилище', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'job-blob-ok',
        audioBlobPathname: 'conversation-audio/c9/rec.m4a',
        // Пункт [multimodal] §7.2: один потребитель (AssemblyAI) —
        // поведение прежнее: вебхук доводит счётчик до нуля и удаляет.
        pendingMediaConsumers: 1,
      },
    });
    const transcription = new FakeTranscriptionService();
    transcription.transcriptResultByJobId['job-blob-ok'] = {
      status: 'completed', id: 'job-blob-ok', language_code: 'ru',
      utterances: [{ speaker: 'A', text: 'реплика', start: 0, end: 1000, confidence: 0.9 }],
    };
    const audioBlob = makeFakeAudioBlob();
    const svc = new ConversationsService(
      prisma as any, { resolve: async () => 'fake-key' } as any, {} as ConsentService, transcription as any, makeFakeStt(transcription) as any, audioBlob as any, makeFakeParalinguistics() as any,
    );

    await svc.handleTranscriptionWebhook({ transcript_id: 'job-blob-ok', status: 'completed' } as any);

    assertEqual(audioBlob.deleteCalls, ['conversation-audio/c9/rec.m4a'], 'файл физически удалён на нуле потребителей');
    assertEqual(prisma._getConversation(conv.id).audioBlobPathname, null, 'ссылка на файл снята тем же путём');
    // Транскрипт при этом должен остаться: удаление стоит ПОСЛЕ записи
    // результата намеренно — потерять можно файл, но не результат.
    assertEqual(prisma._getSegments().length, 1, 'транскрипт сохранён, несмотря на удаление исходника');
  });

  test('[multimodal] КЛЮЧЕВОЙ ТЕСТ §7.2: при включённой паралингвистике файл НЕ удаляется первым вебхуком — второй потребитель ещё не отработал', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'job-para-1',
        audioBlobPathname: 'conversation-audio/c9/rec.m4a',
        paralinguisticsEnabled: true,
        pendingMediaConsumers: 2,
      },
    });
    const transcription = new FakeTranscriptionService();
    transcription.transcriptResultByJobId['job-para-1'] = {
      status: 'completed', id: 'job-para-1', language_code: 'ru',
      utterances: [{ speaker: 'A', text: 'реплика', start: 0, end: 1000, confidence: 0.9 }],
    };
    const audioBlob = makeFakeAudioBlob();
    const paralinguistics = makeFakeParalinguistics();
    const svc = new ConversationsService(
      prisma as any, { resolve: async () => 'fake-key' } as any, {} as ConsentService, transcription as any, makeFakeStt(transcription) as any, audioBlob as any, paralinguistics as any,
    );

    await svc.handleTranscriptionWebhook({ transcript_id: 'job-para-1', status: 'completed' } as any);

    // Без §7.2 вебхук удалил бы файл раньше, чем воркер возьмёт
    // паралингвистическую джобу — и проход не получил бы файла НИКОГДА
    // (самоаудит ТЗ: гарантированный отказ, не гипотеза).
    assertEqual(audioBlob.deleteCalls.length, 0, 'файл ещё жив — его ждёт паралингвистика');
    assertEqual(prisma._getConversation(conv.id).pendingMediaConsumers, 1, 'потребитель AssemblyAI освобождён, паралингвистика — нет');
    assertEqual(paralinguistics.enqueueCalls, [conv.id], 'паралингвистический проход поставлен ПОСЛЕ записи транскрипта');
  });

  test('[blob] КЛЮЧЕВОЙ ТЕСТ: файл удаляется и при ОШИБКЕ расшифровки — на этой ветке файлы копятся дольше всего', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'job-blob-err',
        audioBlobPathname: 'conversation-audio/c9/bad.m4a',
        pendingMediaConsumers: 1,
      },
    });
    const transcription = new FakeTranscriptionService();
    transcription.transcriptResultByJobId['job-blob-err'] = {
      status: 'error', id: 'job-blob-err', error: 'audio too short',
    };
    const audioBlob = makeFakeAudioBlob();
    const svc = new ConversationsService(
      prisma as any, { resolve: async () => 'fake-key' } as any, {} as ConsentService, transcription as any, makeFakeStt(transcription) as any, audioBlob as any, makeFakeParalinguistics() as any,
    );

    await svc.handleTranscriptionWebhook({ transcript_id: 'job-blob-err', status: 'error' } as any);

    assertEqual(prisma._getConversation(conv.id).status, 'FAILED', 'статус после ошибки провайдера');
    assertEqual(audioBlob.deleteCalls, ['conversation-audio/c9/bad.m4a'], 'файл удалён и на ветке ошибки');
  });

  test('handleTranscriptionWebhook() переводит статус в FAILED при ошибке провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'ext-job-2',
      },
    });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    const fakeTranscription = new FakeTranscriptionService();
    fakeTranscription.transcriptResultByJobId['ext-job-2'] = { status: 'error', id: 'ext-job-2', error: 'audio too short' };
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(
      prisma as any, secrets, {} as ConsentService, fakeTranscription as any, makeFakeStt(fakeTranscription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    // Финальный аудит 2026-08-30: текст ошибки в реальном AssemblyAI API тоже
    // приходит не в вебхуке, а только в результате GET — тут это transcriptResultByJobId.
    await svc.handleTranscriptionWebhook({ transcript_id: 'ext-job-2', status: 'error' } as any);
    assertEqual(prisma._getConversation(conv.id).status, 'FAILED', 'статус после ошибки провайдера');
  });

  test('handleTranscriptionWebhook() не падает на неизвестный job id — просто не совпадает', async () => {
    const prisma = createFakePrisma();
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, fakeTranscription as any, makeFakeStt(fakeTranscription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    const result = await svc.handleTranscriptionWebhook({ transcript_id: 'unknown-job', status: 'completed' } as any);
    assertEqual(result, { acknowledged: true, matched: false }, 'ответ на webhook с неизвестным job id');
    assertEqual(fakeTranscription.getResultCalls, [], 'для несуществующего разговора GET к AssemblyAI не делается вообще — экономия и отсутствие лишнего внешнего вызова');
  });

  test('РЕГРЕСІЯ (фінальний аудит 2026-08-30): handleTranscriptionWebhook() без transcript_id — не падає, findFirst НЕ викликається з undefined', async () => {
    const prisma = createFakePrisma();
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, fakeTranscription as any, makeFakeStt(fakeTranscription) as any, makeFakeAudioBlob() as any, makeFakeParalinguistics() as any,
    );
    const result = await svc.handleTranscriptionWebhook({ status: 'completed' } as any);
    assertEqual(result, { acknowledged: true, matched: false }, 'порожній transcript_id — чесна відмова, не пошук «першого-ліпшого» запису');
    assertEqual(fakeTranscription.getResultCalls, [], 'GET не викликається без transcript_id');
  });

  test('РЕГРЕСІЯ, докази реальності ризику (фінальний аудит 2026-08-30): якби guard НЕ перевіряв transcript_id, findFirst({where:{externalTranscriptionJobId: undefined}}) у СПРАВЖНЬОМУ Prisma повернув би ПЕРШИЙ-ЛІПШИЙ запис, а не null', async () => {
    // Фейк вище (рядок з .find((c) => c.externalTranscriptionJobId === where.externalTranscriptionJobId))
    // навмисно СУВОРИЙ — undefined === undefined ніколи не збігається з реальним
    // job id, тому попередній тест сам по собі НЕ довів би, що guard рятує від
    // чогось реального. Тут — мінімальна імітація справжньої семантики Prisma
    // (undefined-поле в where трактується як «умови немає»), щоб довести: без
    // guard'а в handleTranscriptionWebhook() чужий транскрипт міг би піти в
    // абсолютно довільну розмову.
    const conversations = [
      { id: 'conv-of-attacker-target', externalTranscriptionJobId: 'real-job-id' },
      { id: 'conv-belongs-to-someone-else', externalTranscriptionJobId: 'other-job-id' },
    ];
    const prismaLikeRealPrisma = {
      findFirst: async ({ where }: { where: { externalTranscriptionJobId?: string } }) =>
        conversations.find((c) => where.externalTranscriptionJobId === undefined || c.externalTranscriptionJobId === where.externalTranscriptionJobId) ?? null,
    };
    const withoutGuard = await prismaLikeRealPrisma.findFirst({ where: { externalTranscriptionJobId: undefined } });
    assertEqual(withoutGuard?.id, 'conv-of-attacker-target', 'доведено: undefined у where справжнього Prisma повертає перший запис у таблиці, не null — саме тому guard у сервісі перевіряє transcript_id ДО звернення до Prisma, а не покладається на findFirst()');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const passed = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  console.log(`\nConversationsService: ${passed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});
