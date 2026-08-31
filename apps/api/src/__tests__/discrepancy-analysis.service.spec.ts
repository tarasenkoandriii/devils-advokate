import { DiscrepancyAnalysisService } from '../discrepancy-analysis/discrepancy-analysis.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const argumentsStore: any[] = [];
  const signals: any[] = [];
  const evidences: any[] = [];
  const aiInferences = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  function segmentsForTranscript(transcriptId: string, personFilter?: string) {
    return [...segments.values()]
      .filter((s) => s.transcriptId === transcriptId)
      .filter((s) => !personFilter || participants.get(s.participantId)?.personId === personFilter)
      .map((s) => ({ ...s, participant: s.participantId ? participants.get(s.participantId) : null }));
  }

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedTranscript(t: any) { transcripts.set(t.id, t); },
    _seedSegment(s: any) { segments.set(s.id, s); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedAIInference(i: any) { aiInferences.set(i.id, i); },
    _getSignals() { return signals; },

    argument: {
      findMany: async ({ where }: any) => argumentsStore.filter((a) => a.projectId === where.projectId),
    },
    conversation: {
      findUnique: async ({ where }: any) => {
        const c = conversations.get(where.id);
        if (!c) return null;
        const project = projects.get(c.projectId);
        const transcript = [...transcripts.values()].find((t) => t.conversationId === c.id);
        const transcriptWithSegments = transcript
          ? { ...transcript, segments: segmentsForTranscript(transcript.id) }
          : null;
        return { ...c, project, transcript: transcriptWithSegments };
      },
      findMany: async ({ where, include, orderBy, take }: any) => {
        let result = [...conversations.values()].filter(
          (c) => c.projectId === where.projectId && c.id !== where.id.not && where.status.in.includes(c.status),
        );
        // participants: { some: { personId } } — фильтруем по наличию хотя бы одного участника с этим personId
        const requiredPersonId = where.participants?.some?.personId;
        if (requiredPersonId) {
          result = result.filter((c) => {
            const transcript = [...transcripts.values()].find((t) => t.conversationId === c.id);
            if (!transcript) return false;
            return segmentsForTranscript(transcript.id).some((s: any) => s.participant?.personId === requiredPersonId);
          });
        }
        result = result.sort((a, b) => b.occurredAt - a.occurredAt);
        if (take) result = result.slice(0, take);
        if (include?.transcript) {
          result = result.map((c) => {
            const transcript = [...transcripts.values()].find((t) => t.conversationId === c.id);
            const personFilter = include.transcript.include?.segments?.where?.participant?.personId;
            return {
              ...c,
              transcript: transcript ? { ...transcript, segments: segmentsForTranscript(transcript.id, personFilter) } : null,
            };
          });
        }
        return result;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    conversationSignal: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), disputed: false, userConfirmedIntentionalFalsehood: false, createdAt: new Date(), ...data };
        signals.push(s);
        return s;
      },
      findMany: async ({ where, include }: any) => {
        let result = signals.filter(
          (s) => s.signalType === where.signalType && where.transcriptSegmentId.in.includes(s.transcriptSegmentId),
        );
        if (include?.transcriptSegment) {
          result = result.map((s) => {
            const segment = segments.get(s.transcriptSegmentId);
            const participant = segment?.participantId ? participants.get(segment.participantId) : null;
            return { ...s, transcriptSegment: segment ? { ...segment, participant } : null };
          });
        }
        if (include?.evidence) {
          result = result.map((s) => ({
            ...s,
            evidence: evidences
              .filter((e) => e.conversationSignalId === s.id)
              .map((e) => ({ ...e, aiInference: aiInferences.get(e.aiInferenceId) ?? null })),
          }));
        }
        return result;
      },
      findUnique: async ({ where }: any) => {
        const s = signals.find((s) => s.id === where.id);
        if (!s) return null;
        const segment = segments.get(s.transcriptSegmentId);
        const transcript = segment ? transcripts.get(segment.transcriptId) : null;
        const conversation = transcript ? conversations.get(transcript.conversationId) : null;
        const project = conversation ? projects.get(conversation.projectId) : null;
        return {
          ...s,
          transcriptSegment: segment
            ? {
                ...segment,
                transcript: transcript
                  ? { ...transcript, conversation: conversation ? { ...conversation, project } : null }
                  : null,
              }
            : null,
        };
      },
      update: async ({ where, data }: any) => {
        const idx = signals.findIndex((s) => s.id === where.id);
        signals[idx] = { ...signals[idx], ...data };
        return signals[idx];
      },
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), ...data };
        evidences.push(e);
        return e;
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '[]';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
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
const CONV_ID = 'conv-1';
const PERSON_ID = 'person-1';

function seedConversation(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
  prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
  prisma._seedParticipant({ id: 'part-mapped', diarizationLabel: 'A', personId: PERSON_ID });
  prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-mapped', text: 'Я никогда не говорил, что бюджет урезан.' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() бросает BadRequestException, если статус не TRANSCRIBED/ANALYZED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'UPLOADED' });
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadRequestException, 'detect() при статусе UPLOADED');
  });

  test('detect() бросает NotFoundException для чужого разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), NotFoundException, 'detect() на чужой разговор');
  });

  test('detect() подмешивает базу аргументов проекта в промпт', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Бюджет команды урезан в этом квартале', stance: 'CON' });
    const fakeRouter = new FakeAIRouterService();
    await new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */).detect(USER_ID, CONV_ID);

    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Бюджет команды урезан в этом квартале'), true, 'аргумент проекта попал в промпт');
  });

  test('detect() подмешивает историю ТОЛЬКО сопоставленного личности (personId) участника', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    prisma._seedConversation({ id: 'conv-old', projectId: PROJECT_ID, status: 'ANALYZED', occurredAt: new Date(Date.now() - 86400000) });
    prisma._seedTranscript({ id: 'transcript-old', conversationId: 'conv-old' });
    prisma._seedParticipant({ id: 'part-old-mapped', diarizationLabel: 'A', personId: PERSON_ID });
    prisma._seedSegment({ id: 'seg-old', transcriptId: 'transcript-old', participantId: 'part-old-mapped', text: 'Да, бюджет команды урезали на треть.' });
    const fakeRouter = new FakeAIRouterService();

    await new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */).detect(USER_ID, CONV_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('бюджет команды урезали на треть'), true, 'прошлая реплика ТОГО ЖЕ фигуранта попала в промпт');
  });

  test('detect() не падает и не запрашивает историю, если участник не сопоставлен персоне', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
    prisma._seedParticipant({ id: 'part-unmapped', diarizationLabel: 'A', personId: null });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-unmapped', text: 'Реплика без сопоставления' });
    const fakeRouter = new FakeAIRouterService();

    const created = await new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */).detect(USER_ID, CONV_ID);
    assertEqual(created, [], 'не падает при отсутствии сопоставления, просто без истории в промпте');
  });

  test('detect() отклоняет DISCREPANCY без sourceDescription (валидация до записи в БД)', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-1', severity: 'DISCREPANCY', sourceDescription: '', potentialImpact: 'x' }]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    await assertThrowsAsync(
      () => svc.detect(USER_ID, CONV_ID),
      BadGatewayException,
      'DISCREPANCY без источника отклоняется валидацией (validateOutput возвращает false → AIRouter кидает ошибку → сервис оборачивает в 502)',
    );
  });

  test('detect() допускает INACCURACY без sourceDescription (не обязателен для этого уровня)', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-1', severity: 'INACCURACY', sourceDescription: '', potentialImpact: 'x' }]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created.length, 1, 'INACCURACY принята без обязательного источника');
  });

  test('detect() создаёт ConversationSignal(FACTUAL_DISCREPANCY) с правильным severity', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-1', severity: 'STRONG_DISCREPANCY', sourceDescription: 'Противоречит аргументу проекта про урезанный бюджет', potentialImpact: 'Может подорвать доверие к финансовым заявлениям' },
    ]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created[0].signalType, 'FACTUAL_DISCREPANCY', 'signalType корректный');
    assertEqual(created[0].severity, 'STRONG_DISCREPANCY', 'severity из ответа AI');
    assertEqual(created[0].sourceDescription, 'Противоречит аргументу проекта про урезанный бюджет', 'sourceDescription сохранён');
  });

  test('detect() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new DiscrepancyAnalysisService(prisma as any, failingRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadGatewayException, 'detect() при недоступности провайдера');
  });

  test('confirmIntentionalFalsehood() выставляет флаг только по явному ручному действию', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-1', severity: 'INACCURACY', sourceDescription: '', potentialImpact: 'x' }]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    const [created] = await svc.detect(USER_ID, CONV_ID);

    assertEqual(created.userConfirmedIntentionalFalsehood, false, 'по умолчанию false — сервис никогда сам не проставляет');
    const confirmed = await svc.confirmIntentionalFalsehood(USER_ID, created.id);
    assertEqual(confirmed.userConfirmedIntentionalFalsehood, true, 'выставлен явным вызовом');
  });

  test('confirmIntentionalFalsehood() бросает NotFoundException для чужого сигнала', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
    prisma._seedParticipant({ id: 'part-1', diarizationLabel: 'A', personId: null });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-1', text: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-1', severity: 'INACCURACY', sourceDescription: '', potentialImpact: 'x' }]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    const [created] = await svc.detect('other-user', CONV_ID);

    await assertThrowsAsync(
      () => svc.confirmIntentionalFalsehood(USER_ID, created.id),
      NotFoundException,
      'confirmIntentionalFalsehood() на чужой сигнал',
    );
  });

  test('list() восстанавливает sourceDescription из AIInference', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-1', severity: 'DISCREPANCY', sourceDescription: 'Расходится с прошлой беседой', potentialImpact: 'x' }]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await svc.detect(USER_ID, CONV_ID);
    prisma._seedAIInference({ id: fakeRouter.aiInferenceId, output: fakeRouter.responseText });

    const list = await svc.list(USER_ID, CONV_ID);
    assertEqual(list.length, 1, 'сигнал виден через list()');
    assertEqual(list[0].sourceDescription, 'Расходится с прошлой беседой', 'sourceDescription восстановлен');
  });

  // ── checkAgainstUserSource() — Пункт 40, ручная вставка источника ──

  test('checkAgainstUserSource() бросает BadRequestException для небезопасного URL, не вызывает AI вообще', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    await assertThrowsAsync(
      () => svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'http://localhost/admin'),
      BadRequestException,
      'checkAgainstUserSource() с небезопасным URL',
    );
    assertEqual(fakeRouter.lastRequest, null, 'AI не вызывался — проверка URL идёт раньше');
  });

  test('checkAgainstUserSource() бросает NotFoundException для несуществующего segmentId', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);

    await assertThrowsAsync(
      () => svc.checkAgainstUserSource(USER_ID, CONV_ID, 'does-not-exist', 'https://example.com/article'),
      NotFoundException,
      'checkAgainstUserSource() с несуществующим segmentId',
    );
  });

  test('checkAgainstUserSource() бросает BadRequestException, если URL не удалось загрузить', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    (global as any).fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);

    await assertThrowsAsync(
      () => svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'https://example.com/missing'),
      BadRequestException,
      'checkAgainstUserSource() при недоступном URL',
    );
  });

  test('checkAgainstUserSource() создаёт ConversationSignal при outcome=CONTRADICTED', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => '<p>Официальный отчёт: бюджет команды увеличен на 15% в этом квартале.</p>',
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({
      outcome: 'CONTRADICTED',
      severity: 'STRONG_DISCREPANCY',
      explanation: 'Источник говорит про увеличение бюджета, утверждение — про отсутствие изменений',
      potentialImpact: 'Может подорвать доверие к финансовым заявлениям в переговорах',
    });
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const result = await svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'https://example.com/report');
    assertEqual(result.outcome, 'CONTRADICTED', 'outcome передан как есть');
    assertEqual(result.signal !== null, true, 'сигнал создан при противоречии');
    assertEqual(prisma._getSignals().length, 1, 'ровно один сигнал в хранилище');
    assertEqual(
      fakeRouter.lastRequest.userPrompt.includes('бюджет команды увеличен на 15%'),
      true,
      'текст со страницы реально попал в промпт',
    );
  });

  test('checkAgainstUserSource() НЕ создаёт сигнал при outcome=CONFIRMED', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => '<p>Бюджет команды действительно не менялся в этом квартале.</p>',
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ outcome: 'CONFIRMED', explanation: 'Источник подтверждает утверждение' });
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const result = await svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'https://example.com/report');
    assertEqual(result.signal, null, 'сигнал НЕ создан, когда источник подтверждает утверждение');
  });

  test('checkAgainstUserSource() НЕ создаёт сигнал при outcome=INSUFFICIENT', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => '<p>Страница про совершенно другую тему.</p>',
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ outcome: 'INSUFFICIENT', explanation: 'Источник не про бюджет вообще' });
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const result = await svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'https://example.com/unrelated');
    assertEqual(result.signal, null, 'сигнал НЕ создан, когда источник не даёт достаточно информации');
  });

  test('checkAgainstUserSource() бросает BadGatewayException при недоступности AI-провайдера (после успешной загрузки URL)', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    (global as any).fetch = async () => ({ ok: true, headers: { get: () => null }, text: async () => '<p>x</p>' });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new DiscrepancyAnalysisService(prisma as any, failingRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);

    await assertThrowsAsync(
      () => svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'https://example.com/x'),
      BadGatewayException,
      'checkAgainstUserSource() при недоступности провайдера',
    );
  });

  // ── exportFactsToVerify() — Пункт 41, выгрузка списка вместо поиска ──

  test('exportFactsToVerify() возвращает пояснение, если разговор без реплик', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const result = await svc.exportFactsToVerify(USER_ID, CONV_ID);
    assertEqual(result.count, 0, 'нечего выгружать без реплик');
  });

  test('exportFactsToVerify() возвращает пояснение, если расхождений не найдено', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);

    const result = await svc.exportFactsToVerify(USER_ID, CONV_ID);
    assertEqual(result.count, 0, 'нечего выгружать без расхождений');
    assertEqual(result.text.includes('не найдено'), true, 'явное пояснение, не пустая строка');
  });

  test('exportFactsToVerify() нумерует записи и помечает НЕ проверенные вручную как "ТРЕБУЕТ ПРОВЕРКИ"', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-1', severity: 'STRONG_DISCREPANCY', sourceDescription: 'Противоречит аргументу проекта про бюджет', potentialImpact: 'Может подорвать доверие ко всем финансовым заявлениям' },
    ]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await svc.detect(USER_ID, CONV_ID);
    prisma._seedAIInference({ id: fakeRouter.aiInferenceId, output: fakeRouter.responseText });

    const result = await svc.exportFactsToVerify(USER_ID, CONV_ID);
    assertEqual(result.count, 1, 'один сигнал выгружен');
    assertEqual(result.text.includes('1. [СИЛЬНОЕ РАСХОЖДЕНИЕ]'), true, 'нумерация и русская метка серьёзности');
    assertEqual(result.text.includes('ТРЕБУЕТ ПРОВЕРКИ'), true, 'не проверенная вручную запись помечена как требующая проверки');
    assertEqual(
      result.text.includes('Я никогда не говорил, что бюджет урезан'),
      true,
      'текст самой реплики включён в выгрузку',
    );
    assertEqual(
      result.text.includes('(Может подорвать доверие ко всем финансовым заявлениям)'),
      true,
      'potentialImpact включён в скобках в конце строки',
    );
  });

  test('exportFactsToVerify() помечает запись как "проверено вручную" после checkAgainstUserSource()', async () => {
    const prisma = createFakePrisma();
    seedConversation(prisma);
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => '<p>Официальный отчёт: бюджет действительно не менялся.</p>',
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ outcome: 'CONTRADICTED', severity: 'DISCREPANCY', explanation: 'x', potentialImpact: 'x' });
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await svc.checkAgainstUserSource(USER_ID, CONV_ID, 'seg-1', 'https://example.com/report');
    // FakeAIRouterService не создаёт реальную запись AIInference (в
    // отличие от настоящего AIRouterService) — засеиваем вручную с тем
    // же output, что вернул фейковый роутер, иначе
    // resolveSourceDescription() не найдёт, что восстанавливать.
    prisma._seedAIInference({ id: fakeRouter.aiInferenceId, output: fakeRouter.responseText });

    const result = await svc.exportFactsToVerify(USER_ID, CONV_ID);
    assertEqual(result.text.includes('Уже проверено вручную'), true, 'запись, проверенная через ссылку, помечена как уже проверенная');
    assertEqual(result.text.includes('ТРЕБУЕТ ПРОВЕРКИ'), false, 'уже проверенная запись НЕ помечена как требующая проверки');
  });

  test('exportFactsToVerify() правильно считает "требует проверки" отдельно от общего количества', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
    prisma._seedParticipant({ id: 'part-mapped', diarizationLabel: 'A', personId: PERSON_ID });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-mapped', text: 'Утверждение первое.' });
    prisma._seedSegment({ id: 'seg-2', transcriptId: 'transcript-1', participantId: 'part-mapped', text: 'Утверждение второе.' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-1', severity: 'INACCURACY', sourceDescription: '', potentialImpact: 'Низкий приоритет' },
      { segmentId: 'seg-2', severity: 'DISCREPANCY', sourceDescription: 'x', potentialImpact: 'Выше приоритет' },
    ]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await svc.detect(USER_ID, CONV_ID);

    const result = await svc.exportFactsToVerify(USER_ID, CONV_ID);
    assertEqual(result.count, 2, 'всего два сигнала');
    assertEqual(result.text.includes('всего 2, из них требует проверки: 2'), true, 'оба ещё не проверены вручную, оба считаются в "требует проверки"');
    // Пункт 42: сортировка по важности, не по порядку реплик — seg-2
    // (DISCREPANCY, реплика ВТОРАЯ по хронологии) должен оказаться
    // ПЕРВЫМ в выгрузке, потому что важнее seg-1 (INACCURACY).
    const positionOfMoreImportant = result.text.indexOf('Утверждение второе');
    const positionOfLessImportant = result.text.indexOf('Утверждение первое');
    assertEqual(
      positionOfMoreImportant < positionOfLessImportant,
      true,
      'DISCREPANCY (важнее) идёт раньше INACCURACY в тексте, несмотря на обратный хронологический порядок реплик',
    );
  });

  test('exportFactsToVerify() указывает говорящего по имени, если сопоставлен персоне', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
    prisma._seedParticipant({ id: 'part-named', diarizationLabel: 'A', personId: PERSON_ID, person: { displayName: 'Начальник Иван' } });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-named', text: 'Утверждение.' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-1', severity: 'INACCURACY', sourceDescription: '', potentialImpact: 'x' }]);
    const svc = new DiscrepancyAnalysisService(prisma as any, fakeRouter as any, {} as any /* SecretsService — не используется в detect()/list() */);
    await svc.detect(USER_ID, CONV_ID);

    const result = await svc.exportFactsToVerify(USER_ID, CONV_ID);
    assertEqual(result.text.includes('Начальник Иван:'), true, 'displayName персоны использован вместо лейбла диаризации');
  });

  test('exportFactsToVerify() бросает NotFoundException для чужого разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date() });
    const svc = new DiscrepancyAnalysisService(prisma as any, new FakeAIRouterService() as any, {} as any /* SecretsService — не используется в detect()/list() */);

    await assertThrowsAsync(() => svc.exportFactsToVerify(USER_ID, CONV_ID), NotFoundException, 'exportFactsToVerify() на чужой разговор');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nDiscrepancyAnalysisService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();
