// Пункт [anonymised-was-not-anonymous] 2026-09-29 — отчёт об удалении
// называл остающиеся записи обезличенными, а они указывали на человека.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ — ПОВЕДЕНИЕ, А НЕ ТЕКСТ. Удаление прогоняется
// целиком, и у пережившей строки `AIJob` смотрится КАЖДОЕ поле: те, что
// объявлены снимаемыми, обязаны быть пусты, обязательный `inputHash` —
// заменён, остальные — целы, иначе телеметрия, ради которой строка и
// оставлена, перестала бы существовать.
//
// И ЗАМКНУТОСТЬ. Поле, добавленное в `AIJob` и не названное в реестре,
// роняет сверку: следующее поле, указывающее на человека, иначе
// приехало бы молча — а текст про «обезличенные записи» остался бы
// стоять, как стоял двадцать шесть дней до этого.

import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_JOB_AFTER_DELETION, scalarFields } from '../privacy-center/ai-job-residue';
import { SCRUBBED_INPUT_HASH } from '../privacy-center/deletion-report';
import { PrivacyCenterService } from '../privacy-center/privacy-center.service';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Строка джобы со ВСЕМИ полями заполненными: пустое поле нельзя
 *  отличить от снятого, и проверка «стало пусто» была бы зелёной с
 *  самого начала. */
function job(id: string, userId: string): Record<string, unknown> {
  return {
    id,
    inputHash: 'a'.repeat(64),
    modelVersionId: 'mv1',
    promptVersionId: 'pv1',
    status: 'COMPLETED',
    retryCount: 2,
    retryPolicy: '3 attempts',
    fallbackModelVersionId: 'mv2',
    schemaValidation: 'PASS',
    partialResult: 'обрывок ответа провайдера про его ситуацию',
    inputScanStatus: 'PASSED',
    taskType: 'argument',
    pendingRequest: { prompt: 'весь текст запроса человека' },
    leaseExpiresAt: new Date('2026-09-29T10:00:00Z'),
    externalInteractionId: 'provider-task-77',
    requestUserId: userId,
    createdAt: new Date('2026-09-29T09:00:00Z'),
    updatedAt: new Date('2026-09-29T09:30:00Z'),
    completedAt: new Date('2026-09-29T09:31:00Z'),
  };
}

function make(jobs: Array<Record<string, unknown>>) {
  const prisma: any = {
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
    user: {
      findUnique: async () => ({ id: 'u1', telegramId: '123456' }),
      delete: async () => ({}),
    },
    aIJob: {
      findMany: async ({ where }: any) => jobs.filter((j) => j.requestUserId === where.requestUserId).map((j) => ({ id: j.id })),
      updateMany: async ({ where, data }: any) => {
        const hit = jobs.filter(
          (j) =>
            where.id.in.includes(j.id) &&
            (!where.status ||
              (where.status.in ? where.status.in.includes(j.status) : where.status.not ? j.status !== where.status.not : true)),
        );
        for (const j of hit) Object.assign(j, data);
        return { count: hit.length };
      },
    },
    aIInference: { deleteMany: async ({ where }: any) => ({ count: where.aiJobId.in.length }) },
    project: { count: async () => 0 },
    conversation: { count: async () => 0 },
    person: { count: async () => 0 },
    consentRecord: { count: async () => 0 },
    intakeSession: { count: async () => 0 },
    mediaReviewQueue: { count: async () => 0 },
    libraryExperience: { count: async () => 0 },
    libraryEntry: { count: async () => 0 },
    venueBookingConfirmation: { count: async () => 0 },
    approvedVenue: { count: async () => 0 },
    publicComment: { count: async () => 0 },
    publicArgumentSubmission: { count: async () => 0 },
  };
  const audit = { record: async () => undefined, scrubFreeTextForDeletedUser: async () => ({ auditEntriesScrubbed: 0 }) };
  const cleanup = {
    discardForUser: async () => ({ evidenceBlobs: 0, evidenceDeleted: 0, evidenceFailed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 }),
  };
  return new PrivacyCenterService(prisma, audit as any, cleanup as any);
}

/** Пусто ли поле после удаления.
 *
 * У Json-колонки NULL записывается через `Prisma.DbNull` — это
 * значение-указание драйверу, а не содержимое. Фейк драйвера не
 * исполняет и подставляет его как есть; принять его за «текст на месте»
 * значило бы уронить сверку на верном коде. ЧЕСТНАЯ ЦЕНА: что
 * `Prisma.DbNull` в настоящей базе даёт NULL, здесь не доказывается и
 * доказано быть не может — это поведение драйвера. */
function cleared(value: unknown): boolean {
  return value === null || value === undefined || value === Prisma.DbNull;
}

/** Поля, которые обязаны перестать указывать на человека. */
function taken(): string[] {
  return AI_JOB_AFTER_DELETION.filter((f) => f.state === 'снимается').map((f) => f.field);
}

/** Поля, у которых значение изменилось. Одна машинерия на все три
 *  сравнения — чтобы её нельзя было сломать в одном месте незаметно. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => String(after[f]) !== String(before[f]));
}

/** Поля, которые обязаны пережить удаление нетронутыми. */
function kept(): string[] {
  return AI_JOB_AFTER_DELETION.filter((f) => f.state === 'остаётся').map((f) => f.field);
}

describe('[anonymised-was-not-anonymous] «обезличенные записи AI-вызовов»', () => {
  it('замкнутость: каждое поле AIJob названо в реестре, и лишних имён нет', () => {
    const inSchema = scalarFields(SCHEMA, 'AIJob');
    const inRegistry = AI_JOB_AFTER_DELETION.map((f) => f.field);
    expect([...inSchema].sort()).toEqual([...inRegistry].sort());
  });

  it('проба механизма: схема разобрана, а не молча дала пусто', () => {
    // Пустой разбор сделал бы соседнюю проверку сравнением двух пустот.
    expect(scalarFields(SCHEMA, 'AIJob').length).toBe(19);
    expect(scalarFields(SCHEMA, 'НетТакойМодели')).toEqual([]);
  });

  it('у каждого поля реестра записана причина', () => {
    expect(AI_JOB_AFTER_DELETION.filter((f) => f.why.trim().length === 0)).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: после удаления строка джобы больше не указывает на человека', async () => {
    const mine = job('j1', 'u1');

    // Обе строки ниже — не украшение. Без первой мутация «список
    // снимаемых полей пуст» проходит насквозь, без второй — мутация
    // «„пусто" истинно для чего угодно»: пустой ответ пустой машинерии
    // выглядит точно так же, как честно вычищенная строка.
    expect(taken()).toEqual(['partialResult', 'pendingRequest', 'externalInteractionId', 'requestUserId']);
    expect(taken().filter((f) => cleared(mine[f]))).toEqual([]);

    const svc = make([mine]);
    await svc.deleteAccount('u1', 'DELETE');

    const left = taken().filter((f) => !cleared(mine[f]));
    expect(left).toEqual([]);
    expect(mine.inputHash).toBe(SCRUBBED_INPUT_HASH);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: то, ради чего строка оставлена, уцелело', async () => {
    const before = job('j1', 'u1');
    const mine = { ...before };
    const svc = make([mine]);
    await svc.deleteAccount('u1', 'DELETE');

    // Та же цена, что у соседнего теста: пустой список «что уцелело»
    // не отличить от уцелевшего всего. Поймано мутацией.
    expect(kept().length).toBe(14);

    expect(diff(before, mine, kept())).toEqual([]);
  });

  it('обратная проба: чужая джоба не тронута ни одним полем', async () => {
    const before = job('j2', 'stranger');
    const theirs = { ...before };
    const svc = make([job('j1', 'u1'), theirs]);
    await svc.deleteAccount('u1', 'DELETE');

    const all = AI_JOB_AFTER_DELETION.map((f) => f.field);
    expect(diff(before, theirs, all)).toEqual([]);

    // И то же сравнение на подложенном изменении — иначе «ничего не
    // изменилось» значило бы «сравнение ничего не смотрит».
    expect(diff(before, { ...before, requestUserId: 'подменено' }, all)).toEqual(['requestUserId']);
  });

  it('заменяющее значение не может совпасть с настоящим отпечатком', () => {
    // sha256 пишется шестнадцатеричными цифрами. Если бы замена
    // выглядела как хэш, она стала бы ещё одним отпечатком — только
    // общим для всех удалённых.
    expect(/^[0-9a-f]+$/i.test(SCRUBBED_INPUT_HASH)).toBe(false);
    expect(SCRUBBED_INPUT_HASH.length === 64).toBe(false);
  });

  it('отчёт человеку называет число обезличенных записей', async () => {
    const svc = make([job('j1', 'u1'), job('j2', 'u1'), job('j3', 'stranger')]);
    const res = (await svc.deleteAccount('u1', 'DELETE')) as { removed: Record<string, number> };
    expect(res.removed.aiJobsAnonymised).toBe(2);
  });

  it('пустой случай: без джоб число нулевое, а не отсутствующее', async () => {
    const svc = make([]);
    const res = (await svc.deleteAccount('u1', 'DELETE')) as { removed: Record<string, number> };
    expect(res.removed.aiJobsAnonymised).toBe(0);
  });
});
