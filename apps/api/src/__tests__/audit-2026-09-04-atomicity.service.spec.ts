// Сверка «половины операции» 2026-09-04 — что остаётся в базе, если
// операция оборвалась посередине.
//
// Скриптом найдены 72 метода, делающие два и более мутирующих запроса
// подряд без `$transaction`. Большинство безопасны: независимые строки в
// цикле, идемпотентные вебхуки, счётчики. Опасны те, где половина работы
// НЕОТЛИЧИМА от целой — человек видит нормальный экран, а на нём неполная
// правда. Именно они здесь и закрыты.
//
// Главный класс — «находка без основания». `ConversationSignal` (это
// расхождение в словах человека, манипулятивный приём, риск сказать
// лишнее) и `ConversationSignalEvidence` (единственная ссылка на то,
// откуда находка взялась — AIInference или проверка фактчекера) писались
// двумя отдельными вызовами в пяти местах из восьми. Сбой между ними
// оставлял в базе утверждение о человеке, происхождение которого продукт
// назвать уже не может — и ни один экран не показал бы, что основание
// потеряно: находка выглядит как все остальные.
//
// Про фейк и честность этих тестов. У обычного in-memory фейка отката
// нет, поэтому здесь заведён отдельный — он снимает снимок строк перед
// колбэком `$transaction` и возвращает их обратно, если колбэк бросил.
// Это модель отката, а не сам откат: настоящий PostgreSQL здесь ни при
// чём, и тест доказывает ровно одно — что запись идёт ОДНОЙ операцией,
// чей провал не оставляет половины. Проверять на этом уровне семантику
// изоляции было бы враньём, и такого теста тут нет.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { ProjectMode, TermsClauseKind, TermsSheetKind, TermsSide } from '@prisma/client';

import { CandidateSelfShareService } from '../candidate-self-share/candidate-self-share.service';
import { HiringExtrasService } from '../hiring-extras/hiring-extras.service';
import { ManipulationDetectorService } from '../manipulation-detector/manipulation-detector.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TurningPointsService } from '../turning-points/turning-points.service';
import { createFakeRouter, createHiringFakePrisma, fakeAudit } from './fake-prisma';

const SRC = join(__dirname, '..');

// ── Фейк с моделью отката ──

interface RollbackFakeOptions {
  /** Модель, чей create должен упасть — так воспроизводится обрыв на
   * втором шаге пары. */
  failCreateOn?: string;
}

function createRollbackFake(options: RollbackFakeOptions = {}) {
  const tables: Record<string, any[]> = {
    conversationSignal: [],
    conversationSignalEvidence: [],
    conversation: [],
    promptVersion: [],
  };
  let ids = 0;

  const model = (name: string) => ({
    create: async ({ data }: any) => {
      if (options.failCreateOn === name) {
        throw new Error(`db failure while writing ${name}`);
      }
      const row = { id: `${name}-${++ids}`, ...data };
      (tables[name] ??= []).push(row);
      return row;
    },
    findMany: async () => tables[name] ?? [],
    findFirst: async () => (tables[name] ?? [])[0] ?? null,
    update: async ({ where, data }: any) => {
      const row = (tables[name] ?? []).find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
  });

  const handle: any = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === '$transaction') {
          return async (arg: any) => {
            if (typeof arg !== 'function') return Promise.all(arg);
            // Снимок до — и возврат к нему, если колбэк бросил.
            const snapshot = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]]));
            try {
              return await arg(handle);
            } catch (err) {
              for (const [k, v] of Object.entries(snapshot)) tables[k] = v;
              throw err;
            }
          };
        }
        if (key === 'rows') return (name: string) => tables[name] ?? [];
        if (key === 'seed') {
          return (name: string, row: any) => {
            const full = { id: `${name}-${++ids}`, ...row };
            (tables[name] ??= []).push(full);
            return full;
          };
        }
        return model(key);
      },
    },
  );
  return handle;
}

function fakeRouter(text: string) {
  return {
    execute: async () => ({ text, aiInferenceId: 'inf-1', jobId: 'job-1' }),
  } as any;
}

describe('Половина операции: находка без основания в базе не остаётся', () => {
  const SEGMENT = { id: 'seg-1', participantId: 'part-1', text: 'реплика', participant: { diarizationLabel: 'A' } };

  function conversationWithTranscript(prisma: any) {
    return {
      id: 'conv-1',
      projectId: 'p-1',
      status: 'TRANSCRIBED',
      transcript: { id: 'tr-1', segments: [SEGMENT] },
      ...prisma,
    };
  }

  it('КЛЮЧЕВОЙ ТЕСТ: сбой записи основания не оставляет сигнал манипуляции — иначе это утверждение о человеке без источника', async () => {
    const prisma = createRollbackFake({ failCreateOn: 'conversationSignalEvidence' });
    const svc = new ManipulationDetectorService(
      prisma,
      fakeRouter(JSON.stringify([{ segmentId: 'seg-1', technique: 'газлайтинг', description: 'd', confidence: 0.7 }])),
    );
    (svc as any).findOwnedConversationWithTranscript = async () => conversationWithTranscript({});

    await expect(svc.detect('user-1', 'conv-1')).rejects.toThrow(/db failure/);
    expect(prisma.rows('conversationSignal')).toHaveLength(0);
    expect(prisma.rows('conversationSignalEvidence')).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сбой записи основания не оставляет поворотную точку', async () => {
    const prisma = createRollbackFake({ failCreateOn: 'conversationSignalEvidence' });
    const svc = new TurningPointsService(
      prisma,
      fakeRouter(
        JSON.stringify([{ segmentId: 'seg-1', signalType: 'ARGUMENT_ACCEPTANCE', description: 'd', confidence: 0.6 }]),
      ),
    );
    (svc as any).findOwnedConversationWithTranscript = async () => conversationWithTranscript({});

    await expect(svc.detect('user-1', 'conv-1')).rejects.toThrow(/db failure/);
    expect(prisma.rows('conversationSignal')).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сбой записи НЕ оставляет разговор в вечном «анализируется»', async () => {
    // Откат статуса стоял только вокруг AI-вызова: сбой ЗАПИСИ оставлял
    // разговор в ANALYZING навсегда — detect() требует TRANSCRIBED,
    // повторить анализ было нельзя, а человек видел вечный прогресс
    // вместо ошибки. Пустота, притворяющаяся работой, — тот же класс, что
    // ловил заход [silent-failure-sweep], только на сервере.
    const prisma = createRollbackFake({ failCreateOn: 'conversationSignalEvidence' });
    const conversation = prisma.seed('conversation', { projectId: 'p-1', status: 'TRANSCRIBED' });
    const svc = new TurningPointsService(
      prisma,
      fakeRouter(JSON.stringify([{ segmentId: 'seg-1', signalType: 'CONCESSION', description: 'd' }])),
    );
    (svc as any).findOwnedConversationWithTranscript = async () => ({
      id: conversation.id,
      projectId: 'p-1',
      status: 'TRANSCRIBED',
      transcript: { id: 'tr-1', segments: [SEGMENT] },
    });

    await expect(svc.detect('user-1', conversation.id)).rejects.toThrow(/db failure/);
    expect(prisma.rows('conversation')[0].status).toBe('TRANSCRIBED');
  });
});

/** Фейк найма, у которого выбранная модель падает на N-м `create` — так
 * воспроизводится обрыв ровно посередине многошаговой записи. */
function failingAfter(prisma: any, model: string, afterCalls: number) {
  let seen = 0;
  const wrapper: any = new Proxy(prisma, {
    get(target: any, key: string) {
      // `$transaction` фейка передаёт колбэку САМ фейк, а не эту обёртку —
      // иначе падение внутри транзакции не воспроизвести вовсе.
      if (key === '$transaction') {
        return async (arg: any) => {
          if (typeof arg !== 'function') return target.$transaction(arg);
          return target.$transaction(() => arg(wrapper));
        };
      }
      if (key !== model) {
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const real = target[key];
      return new Proxy(real, {
        get(_t, op: string) {
          if (op !== 'create') return real[op];
          return async (args: any) => {
            if (++seen > afterCalls) throw new Error(`db failure while writing ${model}`);
            return real.create(args);
          };
        },
      });
    },
  });
  return wrapper;
}

describe('Половина операции: многошаговая запись в найме', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: лист собеседования не остаётся с ЧАСТЬЮ требований вакансии', async () => {
    // Худший из трёх исходов: повторный вызов находит лист существующим и
    // молча возвращает его как есть, недостающие пункты не появятся уже
    // никогда, а на экране лист выглядит полным. Собеседование велось бы
    // по укороченному списку условий, и никто бы не узнал.
    const prisma = createHiringFakePrisma();
    const project = prisma.seed('project', { ownerId: 'рекрутер', mode: ProjectMode.INTERVIEW_POOL, recruitingTeamId: null });
    const poolConfig = prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Backend' });
    const vacancy = prisma.seed('termsSheet', { projectId: project.id, kind: TermsSheetKind.VACANCY, title: 'Backend', configId: poolConfig.id });
    for (const text of ['Удалённо', 'Отпуск 24 дня', 'Оплата в срок']) {
      prisma.seed('termsClause', { sheetId: vacancy.id, side: TermsSide.EMPLOYER, kind: TermsClauseKind.REQUIREMENT, text, confirmedAt: new Date(), rejectedAt: null, orderIndex: 0 });
    }
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'рекрутер', displayName: 'Анна', consentRevokedAt: null });
    const status = prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });

    const failing = failingAfter(prisma, 'termsClause', 1); // упадёт на втором пункте
    const sheets = new TermsSheetService(failing as any, new TermsMatchingService(failing as any, createFakeRouter(() => '{}') as any), fakeAudit as any);

    await expect(sheets.openForCandidate('рекрутер', status.id)).rejects.toThrow(/db failure/);
    // Ни листа, ни половины пунктов: следующая попытка начнёт с чистого места.
    expect(prisma.rows('termsSheet').filter((s: any) => s.kind === TermsSheetKind.INTERVIEW)).toHaveLength(0);
    expect(prisma.rows('termsClause').filter((c: any) => c.sheetId !== vacancy.id)).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ответы на анкету записываются целиком или не записываются — и ссылка при сбое не сгорает', async () => {
    const prisma = createHiringFakePrisma();
    const project = prisma.seed('project', { ownerId: 'рекрутер', mode: ProjectMode.INTERVIEW_POOL, recruitingTeamId: null, frozenAt: null });
    const config = prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Backend' });
    const q1 = prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт с очередями?', isRequired: true, orderIndex: 0 });
    const q2 = prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт с Kubernetes?', isRequired: false, orderIndex: 1 });
    const profile = prisma.seed('candidateProfile', { ownerUserId: 'рекрутер', displayName: 'Анна', consentRevokedAt: null });
    const status = prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    prisma.seed('preQuestionnaireInvite', { pipelineStatusId: status.id, token: 'preq-atom', expiresAt: new Date(Date.now() + 86_400_000), answeredAt: null });

    const failing = failingAfter(prisma, 'transcriptSegment', 1); // падение на второй реплике
    const router = createFakeRouter(() => '{}');
    const matching = new TermsMatchingService(failing as any, router as any);
    const sheets = new TermsSheetService(failing as any, matching, fakeAudit as any);
    const extras = new HiringExtrasService(failing as any, router as any, fakeAudit as any, sheets, matching);

    await expect(
      extras.submitPreQuestionnaire('preq-atom', {
        aiNoticeAccepted: true,
        transferConsentAccepted: true,
        answers: [
          { questionId: q1.id, text: 'Да, Kafka' },
          { questionId: q2.id, text: 'Да, три года' },
        ],
      }),
    ).rejects.toThrow(/db failure/);

    expect(prisma.rows('conversation')).toHaveLength(0);
    expect(prisma.rows('transcriptSegment')).toHaveLength(0);
    // Ссылка не помечена использованной — кандидат может ответить снова,
    // и второго разговора с половиной ответов не появится.
    expect(prisma.rows('preQuestionnaireInvite')[0].answeredAt).toBeNull();
    // И согласия не зафиксированы отдельно от того, на что они даны.
    expect(prisma.rows('preQuestionnaireInvite')[0].aiNoticeAcceptedAt).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: одноразовая ссылка соискателя не сгорает впустую при сбое приёма', async () => {
    const prisma = createHiringFakePrisma();
    const candidateProject = prisma.seed('project', { ownerId: 'соискатель', mode: ProjectMode.JOB_SEARCH, frozenAt: null });
    prisma.seed('jobSearchConfig', { projectId: candidateProject.id, desiredRole: 'Backend', cvDraft: null });
    const cvVariant = prisma.seed('cvVariant', { projectId: candidateProject.id, text: 'CV соискателя' });
    const candidateSheet = prisma.seed('termsSheet', { projectId: candidateProject.id, kind: TermsSheetKind.VACANCY_RESPONSE, title: 'Отклик' });
    const share = prisma.seed('candidateShare', {
      sharedByUserId: 'соискатель',
      shareToken: 'tok-atom',
      consentSource: 'CANDIDATE_SELF',
      consentTextVersion: 'v3',
      expiresAt: new Date(Date.now() + 86_400_000),
      acceptedAt: null,
      revokedAt: null,
      sourceSheetId: candidateSheet.id,
      sourceCvVariantId: cvVariant.id,
      sourceCandidateId: null,
      visibleClauseIds: [],
    });
    const pool = prisma.seed('project', { ownerId: 'агентство', mode: ProjectMode.INTERVIEW_POOL, recruitingTeamId: null, frozenAt: null });
    prisma.seed('interviewPoolConfig', { projectId: pool.id, jobTitle: 'Backend' });

    const failing = failingAfter(prisma, 'candidatePipelineStatus', 0); // падение сразу после профиля
    const sheets = new TermsSheetService(failing as any, new TermsMatchingService(failing as any, createFakeRouter(() => '{}') as any), fakeAudit as any);
    const selfShare = new CandidateSelfShareService(failing as any, fakeAudit as any, sheets);

    await expect(selfShare.accept('агентство', { token: share.shareToken, projectId: pool.id })).rejects.toThrow(/db failure/);

    expect(prisma.rows('candidateProfile')).toHaveLength(0);
    // Главное: «Эта ссылка уже была принята» при том, что не принято
    // ничего, — человеку пришлось бы делиться своими данными заново.
    expect(prisma.rows('candidateShare')[0].acceptedAt).toBeNull();
    expect(prisma.rows('candidateShare')[0].createdCandidateProfileId).toBeNull();
  });
});

describe('Конвенция: сигнал о человеке пишется только внутри транзакции', () => {
  // Поведенческие тесты выше держат два места из восьми. Эта проверка
  // держит все восемь и, главное, девятое — то, которого ещё нет: новый
  // детектор, написанный по образцу старых, снова разложил бы пару на два
  // вызова, и ни один тест бы этого не заметил.
  //
  // Проверка структурная, и её граница честная: она видит, что запись
  // сделана через `tx.` внутри `$transaction`, но не докажет, что рядом
  // пишется основание. Полностью это держат тесты выше и схема (у
  // `ConversationSignalEvidence` обязательная ссылка на сигнал).
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
      return name.endsWith('.ts') ? [full] : [];
    });
  }

  it('КЛЮЧЕВОЙ ТЕСТ: ни одного `this.prisma.conversationSignal.create` — только `tx.` внутри $transaction', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        if (/this\.prisma\.conversationSignal\.create\(/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('все восемь мест записи сигнала действительно существуют — проверка не проходит просто потому, что искать нечего', () => {
    let found = 0;
    for (const file of tsFiles(SRC)) {
      found += (readFileSync(file, 'utf8').match(/tx\.conversationSignal\.create\(/g) ?? []).length;
    }
    expect(found).toBeGreaterThanOrEqual(8);
  });
});
