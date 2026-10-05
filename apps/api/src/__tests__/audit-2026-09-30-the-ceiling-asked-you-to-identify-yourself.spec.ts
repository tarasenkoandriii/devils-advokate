// Пункт [the-ceiling-asked-you-to-identify-yourself] 2026-09-30 —
// три находки одной сверки: «кто на самом деле охраняет каждую дверь».
//
// ПОВОД. Предыдущий Пункт научился поднимать настоящее приложение и
// читать роутер. Это сразу дало то, чего у проекта не было никогда:
// возможность спросить у КАЖДОГО из 705 маршрутов, какие гварды на нём
// стои́т. Без гварда оказалось 35 — и все 35 уже перечислены в
// `common/public-surfaces.ts` с причиной у каждого, то есть эта часть
// была закрыта до меня. Находки — в том, что реестр обещает, и в том,
// что происходит за его строками.
//
// ── 1. ЛИЧНЫЙ ПОТОЛОК ОБХОДИЛСЯ ПУСТЫМ ПОЛЕМ ────────────────────────
//
// `submissions-per-participant` (20) и `comments-per-participant` (100)
// проверялись ТОЛЬКО когда клиент прислал `participantId`. Поле
// необязательное. Не прислав его, любой отправитель попадал лишь под
// общий потолок обсуждения — 500 заявок и 1000 комментариев вместо 20 и
// 100. Правило существовало ради того, чтобы очередь модерации разобрал
// человек, и для анонимной записи не работало вовсе.
//
// Это не та честная граница, что записана в шапке сервиса («участник —
// не identity-система, повторная регистрация возможна»): повторная
// регистрация стоит строки участника и упирается в свой потолок 200, а
// пустое поле не стоит ничего.
//
// ── 2. РЕЕСТР ОБЕЩАЛ 401 И ОТДАВАЛ 500 ──────────────────────────────
//
// Тип `shared-secret` в реестре описан словами «Без секрета — 401».
// Правда только для отсутствующего ЗАГОЛОВКА. При не выставленной
// переменной окружения пять контроллеров из шести отдавали 500
// «Internal server error». Шестой (`TelegramBotController`) отдавал
// честный 503 — то есть правильный отказ в проекте существовал ровно в
// одном месте из шести.
//
// ── 3. ДВА КОММЕНТАРИЯ, ВЫЖИВАЛ ОДИН ────────────────────────────────
//
// Комментарий заказчика по ссылке вычитки ложился в JSON-колонку
// чтением-склейкой-записью без транзакции: два одновременных
// комментария записывали массив поверх друг друга, первый исчезал без
// следа и без отказа. Тот же класс, что уже исправляли у голосов
// переходом на `{ increment: 1 }`.

import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { assertSharedSecret } from '../common/dispatch-secret';
import { PUBLIC_WRITE_NOT_LIMITED_HERE, publicWriteLimit } from '../common/public-write-limits';
import { PublicDiscussionService } from '../public-discussion/public-discussion.service';

const API_SRC = join(__dirname, '..');

function source(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8');
}

/** Код без комментариев: объяснение рядом с правкой не должно ни
 *  изображать правило, ни ломать его подсчёт. */
function code(rel: string): string {
  const src = source(rel);
  let out = '';
  let state: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (state === 'code') {
      if (two === '//') { state = 'line'; i++; continue; }
      if (two === '/*') { state = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = c; out += c; continue; }
      out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
    } else if (state === 'block') {
      if (two === '*/') { state = 'code'; i++; }
    } else {
      if (c === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (c === state) state = 'code';
      out += c;
    }
  }
  return out;
}

// ─────────── фейковый Prisma для публичных обсуждений ───────────

interface FakeRow {
  id: string;
  projectId: string;
  participantId: string | null;
}

function createFakePrisma(existing: FakeRow[] = []) {
  const submissions = [...existing];
  const comments: FakeRow[] = [];
  let n = 0;
  const countIn = (rows: FakeRow[], where: { projectId: string; participantId?: string | null }) =>
    rows.filter(
      (r) => r.projectId === where.projectId && (where.participantId === undefined || r.participantId === (where.participantId ?? null)),
    ).length;
  const fake: any = {
    // Пункт [the-public-door-counted-then-crossed] 2026-10-05: потолок и
    // запись идут ОДНОЙ транзакцией под advisory-замком. Заглушка
    // обязана знать ту же форму, что production, иначе эти тесты
    // проходили бы и на коде БЕЗ замка.
    $executeRaw: async () => 1,
    $transaction: async (arg: any): Promise<any> => (typeof arg === 'function' ? arg(fake) : Promise.all(arg)),
    _submissions: submissions,
    _comments: comments,
    project: {
      findFirst: async ({ where }: any) =>
        where.publicShareToken === 'good-token' ? { id: 'p1', publicShareToken: 'good-token' } : null,
    },
    publicParticipant: {
      findFirst: async ({ where }: any) => (where.id === 'part-1' ? { id: 'part-1', projectId: 'p1' } : null),
      count: async () => 0,
    },
    publicArgumentSubmission: {
      count: async ({ where }: any) => countIn(submissions, where),
      create: async ({ data }: any) => {
        const row = { id: `s-${++n}`, projectId: data.projectId, participantId: data.participantId ?? null };
        submissions.push(row);
        return { ...row, text: data.text, stance: data.stance, status: 'PENDING', upvotes: 0, downvotes: 0, createdAt: new Date() };
      },
    },
    publicComment: {
      count: async ({ where }: any) => countIn(comments, where),
      create: async ({ data }: any) => {
        const row = { id: `c-${++n}`, projectId: data.projectId, participantId: data.participantId ?? null };
        comments.push(row);
        return { id: row.id };
      },
    },
  };
  return fake;
}

function buildService(prisma: any): PublicDiscussionService {
  // Согласие в этих путях не спрашивается (публичная запись идёт без
  // аккаунта), поэтому заглушка: тест про потолок, а не про согласие.
  const consent = { requireConsent: async () => undefined } as any;
  return new PublicDiscussionService(prisma as any, consent);
}

/** Сколько анонимных заявок влезет до отказа. */
async function anonymousSubmissionsUntilRefusal(limitSeed: FakeRow[]): Promise<number> {
  const prisma = createFakePrisma(limitSeed);
  const service = buildService(prisma);
  let accepted = 0;
  for (let i = 0; i < 40; i++) {
    try {
      await service.submitArgument('good-token', `аргумент ${i}`, 'PRO');
      accepted++;
    } catch (err) {
      if (err instanceof BadRequestException) return accepted;
      throw err;
    }
  }
  return accepted;
}

describe('Пункт [the-ceiling-asked-you-to-identify-yourself]: личный потолок и анонимная запись', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: анонимные заявки упираются в личный потолок, а не только в общий', async () => {
    // Мутация «вернуть проверку под `if (participantId)`» даёт здесь 500
    // принятых вместо 20 — то есть ровно то, что было.
    const personal = publicWriteLimit('submissions-per-participant').value;
    const shared = publicWriteLimit('submissions-per-discussion').value;
    expect(personal).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(personal);
    const accepted = await anonymousSubmissionsUntilRefusal([]);
    expect(accepted).toBe(personal);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: назвавшийся участник получает СВОЙ счёт, не общий с анонимными', async () => {
    // Иначе «поправка» превратила бы личный потолок в общий для всех, и
    // назвавшийся отвечал бы за чужие записи.
    const personal = publicWriteLimit('submissions-per-participant').value;
    // Анонимная корзина уже полна.
    const seeded: FakeRow[] = Array.from({ length: personal }, (_, i) => ({ id: `seed-${i}`, projectId: 'p1', participantId: null }));
    const prisma = createFakePrisma(seeded);
    const service = buildService(prisma);
    // Анонимному уже нельзя.
    await expect(service.submitArgument('good-token', 'ещё один', 'PRO')).rejects.toThrow(BadRequestException);
    // А назвавшемуся — можно.
    const created = await service.submitArgument('good-token', 'от участника', 'PRO', 'part-1');
    expect(created.id.length > 0).toBe(true);
  });

  it('то же правило у комментариев: анонимные считаются одной корзиной', async () => {
    const personal = publicWriteLimit('comments-per-participant').value;
    const prisma = createFakePrisma();
    const service = buildService(prisma);
    for (let i = 0; i < personal; i++) await service.addComment('good-token', `комментарий ${i}`);
    await expect(service.addComment('good-token', 'лишний')).rejects.toThrow(BadRequestException);
    // Назвавшийся не задет.
    expect((await service.addComment('good-token', 'от участника', 'part-1')).id.length > 0).toBe(true);
  });

  it('обратная проба: проверка личного потолка не стои́т под условием наличия participantId', () => {
    // Поведение выше проверено на фейке; здесь — что в коде нет того
    // самого условия, из-за которого потолок и не работал. Без этого
    // правило можно вернуть, оставив тесты зелёными на другом пути.
    const src = code('public-discussion/public-discussion.service.ts');
    expect(/if \(participantId\) \{\s*await assertUnderPublicWriteLimit/.test(src)).toBe(false);
    expect(src.includes("participantId: participantId ?? null")).toBe(true);
  });

  it('размен назван в реестре честных не-ограничений, а не умолчан', () => {
    // Анонимная корзина — одна на обсуждение, и это ограничение самого
    // решения. Реестр «чего эти потолки НЕ делают» существует именно
    // для такого.
    const named = PUBLIC_WRITE_NOT_LIMITED_HERE.some(
      (line) => line.includes('АНОНИМНОЙ') && line.includes('одна корзина'),
    );
    expect(named).toBe(true);
  });
});

describe('Пункт [the-registry-promised-401-and-gave-500]: два разных отказа', () => {
  const resolverWith = (value: string | null) => ({
    resolve: async (ref: string) => {
      if (value === null) throw new Error(`Secret not found for credentialRef="${ref}"`);
      return value;
    },
  });

  it('КЛЮЧЕВОЙ ТЕСТ: переменная не настроена — 503 с именем переменной, а не 500', async () => {
    // Мутация «убрать .catch» возвращает прежний обычный Error, который
    // фильтр переводит в 500 «Internal server error».
    let caught: unknown;
    try {
      await assertSharedSecret(resolverWith(null), 'SCHEDULER_DISPATCH_SECRET', 'whatever');
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof ServiceUnavailableException).toBe(true);
    expect(String((caught as Error).message).includes('SCHEDULER_DISPATCH_SECRET')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: секрет не совпал — 401, и пустой заголовок тоже 401', async () => {
    await expect(assertSharedSecret(resolverWith('right'), 'X_SECRET', 'wrong')).rejects.toThrow(UnauthorizedException);
    await expect(assertSharedSecret(resolverWith('right'), 'X_SECRET', '')).rejects.toThrow(UnauthorizedException);
    await expect(assertSharedSecret(resolverWith('right'), 'X_SECRET', undefined)).rejects.toThrow(UnauthorizedException);
  });

  it('обратная проба: верный секрет проходит молча', async () => {
    await expect(assertSharedSecret(resolverWith('right'), 'X_SECRET', 'right')).resolves.toBeUndefined();
  });

  it('все шесть контроллеров общего секрета идут через ОДНО место', () => {
    // «Правило было, просто не везде» — самая частая находка этого
    // проекта. Здесь она закрыта перечислением: каждый из шести обязан
    // звать общую проверку и не иметь своей копии сравнения.
    const controllers = [
      'ai-router/ai-jobs.controller.ts',
      'calibration/calibration.controller.ts',
      'vacancy-intake/vacancy-intake.controller.ts',
      'scheduler/scheduler.controller.ts',
      'intake/intake.controller.ts',
      'telegram-bot/telegram-bot.controller.ts',
    ];
    const offenders: string[] = [];
    for (const file of controllers) {
      const src = code(file);
      if (!src.includes('assertSharedSecret(')) offenders.push(`${file}: не зовёт общую проверку`);
      // Своё сравнение секрета рядом с общей проверкой означало бы две
      // разные двери в одном файле.
      if (src.includes('safeSecretEqual(') && !file.includes('telegram-bot')) {
        offenders.push(`${file}: осталась своя копия сравнения`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('у telegram-вебхука своя проверка осталась намеренно — и она fail-closed', () => {
    // Вебхук Telegram проверяет ДРУГОЙ секрет (TELEGRAM_WEBHOOK_SECRET)
    // и обязан отвечать 503 при его отсутствии; это не копия
    // dispatch-проверки, а отдельная дверь в том же файле.
    const src = code('telegram-bot/telegram-bot.controller.ts');
    expect(src.includes('TELEGRAM_WEBHOOK_SECRET')).toBe(true);
    expect(src.includes('ServiceUnavailableException')).toBe(true);
  });

  it('реестр поверхностей больше не обещает только 401', () => {
    const src = source('common/public-surfaces.ts');
    expect(src.includes('503 — переменная окружения не настроена')).toBe(true);
  });
});

describe('Пункт [two-comments-one-survived]: запись комментария атомарна', () => {
  // Пункт [the-atomic-fix-stayed-on-one-path] 2026-10-01: сам оператор
  // ПЕРЕЕХАЛ. Эти два теста смотрели в `vacancy-posting.service.ts` — и
  // упали в первом живом прогоне CI, потому что ту же колонку пишет
  // второй путь (работодатель через `engagement`), у которого записи не
  // было вообще, и добавление стало ОДНОЙ функцией для обоих.
  //
  // Правило не ослаблено, а усилено: раньше проверялось, что атомарная
  // запись есть у одного пути, теперь — что она ОДНА и что к ней ходят
  // ОБА. Падение сторожа здесь сработало именно так, как должно:
  // переезд правила обязан быть замечен.
  const HELPER = 'vacancy-posting/posting-review-comments.ts';

  it('КЛЮЧЕВОЙ ТЕСТ: добавление идёт одним UPDATE с условием потолка, а не чтением-склейкой-записью', () => {
    const src = code(HELPER);
    // Один оператор: склейка `||` и условие по длине в том же запросе.
    expect(src.includes("SET comments = COALESCE(comments, '[]'::jsonb) ||")).toBe(true);
    expect(src.includes('jsonb_array_length(COALESCE(comments')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: оба пути к этой колонке ходят через общий оператор, и ни один не собирает массив в памяти', () => {
    for (const file of ['vacancy-posting/vacancy-posting.service.ts', 'employer-hiring/engagement.service.ts']) {
      const src = code(file);
      // Именно ВЫЗОВ, а не упоминание в импорте.
      expect(src.includes('appendPostingReviewComment(this.prisma')).toBe(true);
      expect(src.includes('data: { comments: comments as never }')).toBe(false);
    }
  });

  it('оператор существует ровно в одном месте — иначе «один» было бы словом, а не фактом', () => {
    const inHelper = (code(HELPER).match(/UPDATE posting_review_shares/g) ?? []).length;
    expect(inHelper).toBe(1);
    for (const file of ['vacancy-posting/vacancy-posting.service.ts', 'employer-hiring/engagement.service.ts']) {
      expect((code(file).match(/UPDATE posting_review_shares/g) ?? []).length).toBe(0);
    }
  });

  it('ноль в реестре по-прежнему означает «не ограничивай»', () => {
    // В условии SQL «меньше нуля» запретило бы всё — ровно наоборот
    // тому, что ноль значит в обоих реестрах потолков.
    expect(code(HELPER).includes('configured === 0 ? 2_147_483_647 : configured')).toBe(true);
  });
});
