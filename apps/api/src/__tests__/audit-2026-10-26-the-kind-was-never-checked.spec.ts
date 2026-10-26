// Сверка [the-kind-was-never-checked] 2026-10-26 — проверка доступа
// отвечала на другой вопрос, чем задавал метод.
//
// НАЙДЕННОЕ. Восемь доменов имеют `appendAnswer` и `extract` для
// ОНБОРДИНГ-разговора, а проверяли они только владение: «его ли это
// разговор», тогда да. Вопрос метода другой — «ТОТ ЛИ это разговор».
// Значит по этим путям проходил ЛЮБОЙ разговор человека, включая
// настоящую расшифровку встречи:
//   • `appendAnswer` дописывал реплику в чужой транскрипт — строку,
//     которой в том разговоре никто не говорил, и ничем не помеченную;
//   • `extract` читал ВЕСЬ транскрипт и отдавал его модели как ответы
//     квиза, заполняя из него конфиг домена (и тратя платный вызов);
//   • общий `getOnboardingAnswers` возвращал сегменты любого разговора
//     как «ответы онбординга» — при этом его отказ НАЗЫВАЕТ вид
//     («Onboarding conversation … not found»), то есть утверждал то,
//     чего не проверял.
//
// И ГЛАВНОЕ: УРОК БЫЛ УЖЕ ЗАПИСАН В ЭТОМ ЖЕ ФАЙЛЕ. Ревью 2026-09-02 в
// `common/onboarding-conversation.ts` описало ровно этот вред —
// «импортированный чат оказался бы онбординг-разговором: ответы
// дописались бы в чужой транскрипт, а extract прочитал бы всю переписку
// как ответы пользователя» — и добавило признак (участник SELF) В
// ПОИСК. Половина пары получила признаки, вторая продолжала брать id
// снаружи. Признаки, которые проверяет только поиск, инвариантом не
// являются.
//
// ПОЧЕМУ ЭТОГО НЕ ВИДЕЛ НИ ОДИН ИЗ 2159 ТЕСТОВ: ни один не звал
// `appendAnswer`/`extract` с НЕ-онбординг-разговором. Правка не уронила
// ни одного теста — и это не похвала правке, а измерение покрытия.

import { NotFoundException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { DtpOnboardingService } from '../dtp/dtp-onboarding.service';
import { getOnboardingAnswers } from '../common/domain-onboarding-reads';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Файлы, где метод принимает `conversationId` снаружи и обязан
 *  убедиться, что это ОНБОРДИНГ-разговор: восемь доменов плюс общий
 *  помощник чтения. Список по признаку, а не по именам: новый домен
 *  обязан попасть под правило сам. */
function onboardingEntryPoints(): string[] {
  return tsFiles(API_SRC)
    .filter((f) => {
      const src = withoutComments(readFileSync(f, 'utf8'));
      // `async function NAME(` — тоже дверь. Первая редакция этого
      // выражения требовала `async NAME(` и молча пропускала ОБЩИЙ
      // помощник `getOnboardingAnswers`, объявленный как
      // `export async function`, — то есть ровно то место, через
      // которое читают все шесть доменов. Измерение, не видящее самого
      // опасного места, зеленеет и ничего не означает.
      const takesId = /async (?:function\s+)?(appendAnswer|extract|getChecklist|getOnboardingAnswers)\s*\([^)]*conversationId/.test(
        src,
      );
      return takesId;
    })
    .map((f) => f.slice(API_SRC.length + 1))
    .sort();
}

describe('Сверка [the-kind-was-never-checked]: «тот ли это разговор» — вопрос отдельный от «его ли»', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: каждая дверь онбординга проверяет ВИД разговора, а не только владение', () => {
    const offenders = onboardingEntryPoints().filter(
      (rel) => !withoutComments(readFileSync(join(API_SRC, rel), 'utf8')).includes('assertOnboardingConversation'),
    );
    expect(offenders).toEqual([]);
  });

  it('измерение на виду: дверей столько, сколько их есть', () => {
    // Восемь доменов (dtp, family-law, health, interview-pool,
    // investment, job-search, major-purchase, employer-hiring) плюс
    // общий помощник чтения. Число живёт здесь, чтобы следующая сверка
    // начинала с факта, а не с пересчёта.
    expect(onboardingEntryPoints().length).toBeGreaterThanOrEqual(9);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: признаки онбординга объявлены в ОДНОМ месте', () => {
    // Копия признаков — это ровно тот дефект, который закрывает Пункт:
    // поиск знал их, проверка нет. Литеральный набор признаков вне
    // общего модуля означал бы третью копию.
    const offenders: string[] = [];
    for (const file of tsFiles(API_SRC)) {
      const rel = file.slice(API_SRC.length + 1);
      if (rel === 'common/onboarding-conversation.ts') continue;
      const src = withoutComments(readFileSync(file, 'utf8'));
      const hasLiteralCriteria =
        /diarizationLabel:\s*'SELF'/.test(src) && /sourceType:\s*ConversationSourceType\.TEXT_IMPORT/.test(src);
      if (hasLiteralCriteria) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: без проверки файл НАХОДИТСЯ — иначе пустой список выше ничего не значит', () => {
    const src = "async appendAnswer(userId: string, conversationId: string) { await this.assertOwnedConversation(userId, conversationId); }";
    expect(
      /async (?:function\s+)?(appendAnswer|extract|getChecklist|getOnboardingAnswers)\s*\([^)]*conversationId/.test(src),
    ).toBe(true);
    expect(withoutComments(src).includes('assertOnboardingConversation')).toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: проверка В КОММЕНТАРИИ не считается', () => {
    const src = "// await assertOnboardingConversation(this.prisma, conversation);\nasync appendAnswer(userId: string, conversationId: string) {}";
    expect(withoutComments(src).includes('assertOnboardingConversation')).toBe(false);
  });
});

// ─────────── поведение: чужой разговор не проходит ───────────

interface SeedConversation {
  id: string;
  projectId: string;
  sourceType: string;
  labels: string[];
  hasTranscript: boolean;
  createdAt: Date;
}

function fakePrisma(conversations: SeedConversation[], ownerId = 'u1') {
  const segments: Array<{ transcriptId: string; text: string }> = [];
  /** Отбор идёт по ТОМУ, ЧТО СПРОСИЛИ, а не по заложенному в заглушку.
   *
   *  Первая редакция проверяла `c.labels.includes('SELF')` сама — и
   *  мутация «убрать признак участника SELF из продукта» её ПЕРЕЖИЛА:
   *  признак применяла заглушка, а не код. Это ровно та болезнь, за
   *  которой этот ряд сверок и ходит, поймана на себе. */
  const matchesOnboarding = (c: SeedConversation, where: any) => {
    if (c.projectId !== where.projectId) return false;
    if (where.sourceType !== undefined && c.sourceType !== where.sourceType) return false;
    const wantedLabel = where.participants?.some?.diarizationLabel;
    const wantedSelf = where.participants?.some?.isSelf;
    if (wantedLabel !== undefined) {
      if (!c.labels.includes(wantedLabel)) return false;
      // `isSelf` у затравок совпадает с меткой SELF: другие метки
      // ставит импорт, и у них `isSelf: false`.
      if (wantedSelf === true && wantedLabel !== 'SELF') return false;
    }
    if (where.transcript?.isNot === null && !c.hasTranscript) return false;
    return true;
  };
  const fake: any = {
    _segments: segments,
    conversation: {
      findUnique: async ({ where }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        return c ? { ...c, project: { id: c.projectId, ownerId } } : null;
      },
      findFirst: async ({ where }: any) => {
        // Отбор онбординг-разговора проекта — тот же, что в продукте.
        const matching = conversations
          .filter((c) => matchesOnboarding(c, where))
          .sort((a, b) => +a.createdAt - +b.createdAt || (a.id < b.id ? -1 : 1));
        return matching[0] ? { id: matching[0].id } : null;
      },
    },
    transcript: {
      findUnique: async ({ where }: any) => ({ id: `t-${where.conversationId}` }),
    },
    conversationParticipant: {
      findFirst: async () => ({ id: 'p1' }),
    },
    transcriptSegment: {
      findFirst: async () => null,
      findMany: async () => [{ text: 'настоящая встреча' }],
      create: async ({ data }: any) => {
        segments.push(data);
        return { id: `s${segments.length}`, ...data };
      },
    },
  };
  return fake;
}

const ONBOARDING: SeedConversation = {
  id: 'onb',
  projectId: 'p1',
  sourceType: 'TEXT_IMPORT',
  labels: ['SELF'],
  hasTranscript: true,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
};
/** Импорт переписки: тот же `sourceType` и тот же транскрипт, участники
 *  с метками `IMPORTED_<i>`. Именно его ревью 2026-09-02 и называло.
 *
 *  Создан РАНЬШЕ онбординга — и это не деталь затравки, а условие, при
 *  котором признак участника вообще что-то решает. Сначала он стоял
 *  позже, и мутация «убрать признак SELF» ПЕРЕЖИЛА: отбор «самый
 *  ранний» и без признака давал нужный разговор. Ровно тот случай, о
 *  котором говорит ревью: «импортированный ДО первого открытия
 *  онбординга чат оказался бы онбординг-разговором». */
const IMPORTED_CHAT: SeedConversation = {
  id: 'chat',
  projectId: 'p1',
  sourceType: 'TEXT_IMPORT',
  labels: ['IMPORTED_0', 'IMPORTED_1'],
  hasTranscript: true,
  createdAt: new Date('2026-09-30T10:00:00.000Z'),
};
/** Настоящая запись встречи. */
const MEETING: SeedConversation = {
  id: 'meeting',
  projectId: 'p1',
  sourceType: 'AUDIO_UPLOAD',
  labels: ['SPEAKER_00', 'SPEAKER_01'],
  hasTranscript: true,
  createdAt: new Date('2026-10-03T10:00:00.000Z'),
};

describe('[the-kind-was-never-checked] поведение: в чужой транскрипт не дописывается ничего', () => {
  function service(prisma: any) {
    const aiRouter = {
      execute: async () => {
        throw new Error('платный вызов не должен состояться для чужого разговора');
      },
    };
    return new DtpOnboardingService(prisma, aiRouter as any);
  }

  it('КЛЮЧЕВОЙ ТЕСТ: ответ квиза в настоящую расшифровку встречи — отказ, и НИ ОДНОЙ записи', async () => {
    const prisma = fakePrisma([ONBOARDING, MEETING]);
    await expect(service(prisma).appendAnswer('u1', 'meeting', 'это ответ квиза')).rejects.toThrow(NotFoundException);
    expect(prisma._segments).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: импортированная переписка — тоже отказ (тот самый случай ревью 2026-09-02)', async () => {
    const prisma = fakePrisma([ONBOARDING, IMPORTED_CHAT]);
    await expect(service(prisma).appendAnswer('u1', 'chat', 'это ответ квиза')).rejects.toThrow(NotFoundException);
    expect(prisma._segments).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: в настоящий онбординг-разговор ответ пишется — правка не заперла дверь', async () => {
    const prisma = fakePrisma([ONBOARDING, IMPORTED_CHAT, MEETING]);
    await service(prisma).appendAnswer('u1', 'onb', 'ответ квиза');
    expect(prisma._segments).toHaveLength(1);
    expect(prisma._segments[0]).toMatchObject({ text: 'ответ квиза', transcriptId: 't-onb' });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: extract чужого разговора отказывает ДО платного вызова модели', async () => {
    // Фейк роутера бросает «платный вызов не должен состояться»;
    // NotFoundException означает, что до него не дошли.
    const prisma = fakePrisma([ONBOARDING, MEETING]);
    await expect(service(prisma).extract('u1', 'meeting')).rejects.toThrow(NotFoundException);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: общий getOnboardingAnswers не отдаёт чужой разговор как «ответы»', async () => {
    const prisma = fakePrisma([ONBOARDING, MEETING]);
    prisma.conversation.findFirst = (async ({ where }: any) => {
      if (where.id !== undefined) {
        const c = [ONBOARDING, MEETING].find((x) => x.id === where.id);
        return c ? { id: c.id, projectId: c.projectId, status: 'TRANSCRIBED', createdAt: c.createdAt } : null;
      }
      const matching = [ONBOARDING, MEETING]
        .filter(
          (c) =>
            c.projectId === where.projectId &&
            (where.sourceType === undefined || c.sourceType === where.sourceType) &&
            (where.participants?.some?.diarizationLabel === undefined ||
              c.labels.includes(where.participants.some.diarizationLabel)),
        )
        .sort((a, b) => +a.createdAt - +b.createdAt);
      return matching[0] ? { id: matching[0].id } : null;
    }) as never;
    prisma.transcript.findUnique = (async () => ({ segments: [{ id: 's1', text: 'встреча', startMs: 1 }] })) as never;

    await expect(getOnboardingAnswers(prisma, 'u1', 'meeting')).rejects.toThrow(NotFoundException);
    const ok = await getOnboardingAnswers(prisma, 'u1', 'onb');
    expect(ok.answers.map((a) => a.text)).toEqual(['встреча']);
  });
});
