// Пункт [the-retry-killed-the-record] 2026-09-30 — бюджет функции у
// синхронной полосы AI-роутера.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ТАК.
//
// 1. Решение о повторе — ПО ОСТАТКУ, а не по номеру попытки. Мутация
//    «вернуть решение по номеру попытки» должна ронять сверку, поэтому
//    оба случая проверяются ПОВЕДЕНИЕМ: быстрый отказ даёт два
//    обращения к провайдеру, истёкший потолок — одно. Часы подменяются,
//    а не ждутся: тест, который ждёт 45 секунд, никто не запустит.
//
// 2. Число предела живёт в ОДНОМ месте. Его две копии — в коде и в
//    `vercel.json` — сверяются здесь, потому что расходились уже дважды:
//    комментарий в роутере говорил «maxDuration: 10» при 60 в конфиге, и
//    ТЗ мультимодальности до сих пор пишет 10.
//
// 3. Синхронная джоба получает срок аренды. Без него сторожевая её не
//    видит вообще (`leaseExpiresAt: { lt: now }` для NULL ложно), и
//    убитая платформой джоба остаётся RUNNING навсегда. Проверяется
//    именно ЗАПИСЬ в базе, а не наличие константы.
//
// 4. Сторожевая называет синхронной полосе СВОЮ причину. «Воркер не
//    поставил задачу» про полосу без воркера отправляет оператора
//    проверять pg_cron-джобы, которые тут ни при чём.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FUNCTION_MAX_DURATION_MS,
  OUTCOME_WRITE_RESERVE_MS,
  PROVIDER_CALL_BUDGET_MS,
  SYNC_LEASE_MS,
  fitsAnotherProviderCall,
  msLeftForOutcome,
  outcomeDeadline,
} from '../ai-router/sync-budget';
import { AIRouterService } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { ContentScanService } from '../content-scan/content-scan.service';
import { PERSON_TEXTS } from '../ai-router/failure-reason';

const API_ROOT = join(__dirname, '..', '..');
const USER_ID = 'user-budget';

function readSource(rel: string): string {
  return readFileSync(join(API_ROOT, rel), 'utf8');
}

// ───────────────────────────── фейки ─────────────────────────────

function createFakePrisma() {
  const jobs = new Map<string, any>();
  /** Данные КАЖДОГО создания — отдельно от итогового состояния строки.
   *  Срок аренды выставляется при создании и снимается при завершении,
   *  поэтому по итоговой строке его не проверить: проверять надо то, что
   *  уехало в базу в момент постановки. */
  const created: any[] = [];
  let n = 0;
  const nextId = () => `job-${++n}`;
  return {
    _jobs: jobs,
    _job(id: string) {
      return jobs.get(id);
    },
    _all() {
      return [...jobs.values()];
    },
    _created() {
      return created;
    },
    user: { findUnique: async () => ({ languageCode: 'ru' }) },
    aIJob: {
      count: async () => 0,
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const job = { id: nextId(), retryCount: 0, ...data };
        created.push({ ...data });
        jobs.set(job.id, job);
        return job;
      },
      update: async ({ where, data }: any) => {
        const job = jobs.get(where.id) ?? {};
        const merged = { ...job, ...data };
        if (data.retryCount?.increment) merged.retryCount = (job.retryCount ?? 0) + data.retryCount.increment;
        jobs.set(where.id, merged);
        return merged;
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const job = jobs.get(where.id);
        if (!job) throw new Error('job not found');
        return job;
      },
      findMany: async (): Promise<any[]> => [],
    },
    aIModelVersion: {
      findUnique: async () => ({
        id: 'mv-openai',
        version: 'gpt-4.1',
        model: { name: 'gpt-4.1', provider: { name: 'openai', apiEndpoint: 'https://api.openai.com/v1', credentialRef: 'OPENAI_API_KEY' } },
      }),
    },
    aIModelCapability: {
      findMany: async () => [
        {
          modelVersionId: 'mv-openai',
          taskType: 'argument-generation',
          availability: 'active',
          modelVersion: {
            id: 'mv-openai',
            version: 'gpt-4.1',
            model: { name: 'gpt-4.1', provider: { name: 'openai', apiEndpoint: 'https://api.openai.com/v1', credentialRef: 'OPENAI_API_KEY' } },
          },
        },
      ],
    },
    aIInference: { create: async ({ data }: any) => ({ id: `inf-${++n}`, ...data }) },
    consentRecord: {
      // Пункт [the-first-row-was-whichever] 2026-10-05: согласие считается
      // по ВСЕМ действующим записям — заглушка обязана знать `findMany`.
      findFirst: async ({ where }: any) =>
        where.consentType === 'EXTERNAL_AI' && where.userId === USER_ID
          ? { id: 'c1', userId: USER_ID, consentType: 'EXTERNAL_AI', granted: true, revokedAt: null }
          : null,
      findMany: async ({ where }: any) =>
        where.consentType === 'EXTERNAL_AI' && where.userId === USER_ID
          ? [{ id: 'c1', userId: USER_ID, consentType: 'EXTERNAL_AI', granted: true, revokedAt: null }]
          : [],
    },
    contentScanResult: { create: async ({ data }: any) => ({ id: `scan-${++n}`, ...data }), updateMany: async () => ({ count: 1 }) },
    contentScanDetection: { create: async ({ data }: any) => ({ id: `det-${++n}`, ...data }) },
    project: { findUnique: async () => ({ frozenAt: null }) },
  };
}

function buildRouter(prisma: any) {
  const consent = new ConsentService(prisma as any);
  const contentScan = new ContentScanService(prisma as any);
  return new AIRouterService(
    prisma as any,
    { resolve: async () => 'sk-test' } as any,
    consent,
    contentScan,
    { resolve: async () => ({ uri: 'https://x' }) } as any,
  );
}

/** Часы, которыми управляет тест, и провайдер, который «тратит» время.
 *
 *  Каждое обращение к провайдеру двигает часы на `costMs` и отвечает
 *  отказом, который роутер считает повторяемым (HTTP 500). Так истечение
 *  потолка отличается от быстрого отказа ровно тем, чем отличается
 *  вживую, — потраченным временем, а не видом ошибки. */
function providerThatSpends(costMs: number) {
  const realNow = Date.now.bind(Date);
  const base = realNow();
  let elapsed = 0;
  let calls = 0;
  Date.now = () => base + elapsed;
  (global as any).fetch = async () => {
    calls++;
    elapsed += costMs;
    return {
      ok: false,
      status: 500,
      statusText: 'Error',
      json: async () => ({ error: 'boom' }),
      text: async () => 'boom',
    };
  };
  return {
    calls: () => calls,
    restore: () => {
      Date.now = realNow;
    },
  };
}

// ──────────────────────── сами проверки ────────────────────────

describe('Пункт [the-retry-killed-the-record]: повтор не должен убивать запись об ошибке', () => {
  it('решение о повторе принимается по остатку: 45 с потолка не оставляют места, быстрый отказ — оставляет', () => {
    const start = 1_000_000;
    // Попытка упёрлась в свой потолок: до момента «записывать поздно»
    // остаётся меньше, чем стоит ещё один вызов.
    expect(fitsAnotherProviderCall(start, start + PROVIDER_CALL_BUDGET_MS)).toBe(false);
    // Попытка упала за две секунды: место есть.
    expect(fitsAnotherProviderCall(start, start + 2_000)).toBe(true);
    // Граница названа явно, а не «примерно»: ещё один вызов влезает
    // ровно до предела минус резерв на запись.
    const last = outcomeDeadline(start) - PROVIDER_CALL_BUDGET_MS;
    expect(fitsAnotherProviderCall(start, last)).toBe(true);
    expect(fitsAnotherProviderCall(start, last + 1)).toBe(false);
  });

  it('резерв на запись исхода ненулевой и вычтен из предела', () => {
    expect(OUTCOME_WRITE_RESERVE_MS).toBeGreaterThan(0);
    expect(outcomeDeadline(0)).toBe(FUNCTION_MAX_DURATION_MS - OUTCOME_WRITE_RESERVE_MS);
    expect(msLeftForOutcome(0, FUNCTION_MAX_DURATION_MS)).toBeLessThan(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: попытка, истратившая потолок, НЕ повторяется — второго обращения к провайдеру нет', async () => {
    // Мутация «убрать гейт» даёт здесь два обращения вместо одного:
    // именно они вживую доводят функцию до обрыва платформой, в котором
    // не исполняется ни один catch и причина провала не пишется никуда.
    const prisma = createFakePrisma();
    const provider = providerThatSpends(PROVIDER_CALL_BUDGET_MS);
    try {
      const router = buildRouter(prisma);
      await expect(
        router.execute({ userId: USER_ID, taskType: 'argument-generation', userPrompt: 'вопрос про зарплату', jsonMode: true }),
      ).rejects.toThrow();
      expect(provider.calls()).toBe(1);
    } finally {
      provider.restore();
    }
    // И джоба закрыта, а не оставлена в RUNNING: запись об исходе — это
    // то, ради чего повтор и отменён.
    const job = prisma._all()[0];
    expect(job.status).toBe('FAILED');
    expect(job.leaseExpiresAt).toBeNull();
  });

  it('обратная проба: быстрый повторяемый отказ повторяется — гейт не запрещает повторы вообще', async () => {
    const prisma = createFakePrisma();
    const provider = providerThatSpends(1_500);
    try {
      const router = buildRouter(prisma);
      await expect(
        router.execute({ userId: USER_ID, taskType: 'argument-generation', userPrompt: 'вопрос про зарплату', jsonMode: true }),
      ).rejects.toThrow();
      expect(provider.calls()).toBe(2);
    } finally {
      provider.restore();
    }
  });

  it('синхронная джоба создаётся СО сроком аренды — иначе сторожевая её не видит', async () => {
    const prisma = createFakePrisma();
    const provider = providerThatSpends(PROVIDER_CALL_BUDGET_MS);
    let atCreation: any;
    let nowAtCreation = 0;
    try {
      const router = buildRouter(prisma);
      nowAtCreation = Date.now();
      await router
        .execute({ userId: USER_ID, taskType: 'argument-generation', userPrompt: 'вопрос про зарплату', jsonMode: true })
        .catch(() => undefined);
      atCreation = prisma._created()[0];
      // Срок заведомо больше предела функции: пока функция жива, она
      // закончит сама и снимет срок.
      expect(SYNC_LEASE_MS).toBeGreaterThan(FUNCTION_MAX_DURATION_MS);
    } finally {
      provider.restore();
    }
    // Проверяется то, что уехало в базу при постановке, а не константа:
    // константа, которую никто не кладёт в строку, ничего не сторожит, —
    // ровно так сторожевая и не видела эту полосу.
    expect(atCreation).toBeDefined();
    expect(atCreation.leaseExpiresAt instanceof Date).toBe(true);
    expect(atCreation.leaseExpiresAt.getTime() >= nowAtCreation + FUNCTION_MAX_DURATION_MS).toBe(true);
    // И завершение срок снимает — оставленный читался бы как «эта джоба
    // когда-то зависала».
    const finalRow = prisma._all()[0];
    expect(finalRow.status).toBe('FAILED');
    expect(finalRow.leaseExpiresAt).toBeNull();
  });

  it('число предела функции в коде совпадает с vercel.json', () => {
    const vercel = JSON.parse(readSource('vercel.json'));
    const seconds = vercel.functions['api/index.ts'].maxDuration;
    expect(FUNCTION_MAX_DURATION_MS).toBe(seconds * 1000);
  });

  it('потолок одного обращения к провайдеру в коде совпадает с потолком в клиенте провайдера', () => {
    const client = readSource('src/ai-router/ai-provider-client.ts');
    // Ровно то число, что стои́т у вызовов LLM. Расхождение здесь
    // означало бы, что бюджет считается не по тому, что тратится.
    expect(client.includes(`${PROVIDER_CALL_BUDGET_MS / 1000}_000`)).toBe(true);
    expect(PROVIDER_CALL_BUDGET_MS).toBeLessThan(FUNCTION_MAX_DURATION_MS);
  });

  it('у сторожевой три причины, и у синхронной полосы своя — без «воркера» и «pg_cron»', () => {
    const source = readSource('src/ai-router/ai-router.service.ts');
    // Разделение полос сделано по pendingRequest — полю, которое уже
    // несёт эту роль в заборе джоб воркером.
    expect(source.includes('const syncLane = job.pendingRequest === null || job.pendingRequest === undefined')).toBe(true);
    expect(source.includes("failureText(\n            'function-cut-off'")).toBe(true);

    const person = PERSON_TEXTS['function-cut-off'];
    expect(typeof person).toBe('string');
    expect(person.length > 40).toBe(true);
    // Человеку — его словами: ни внутренних имён, ни советов проверить
    // наши джобы.
    expect(/lease|pg_cron|maxDuration|EXTERNAL_INTERACTION|worker/i.test(person)).toBe(false);
    // И честно про потолок: оборванная попытка его уже израсходовала.
    expect(person.includes('лимит')).toBe(true);
    // Три причины различимы между собой — иначе оператор читает одно и
    // то же про разные события.
    const three = [PERSON_TEXTS['function-cut-off'], PERSON_TEXTS['worker-never-sent'], PERSON_TEXTS['provider-timeout']];
    expect(new Set(three).size).toBe(3);
  });

  it('бюджет применён и к запасному движку: ещё один вызов провайдера стоит столько же, сколько повтор', () => {
    const source = readSource('src/ai-router/ai-router.service.ts');
    expect(source.includes('if (fallbackVersion && fitsAnotherProviderCall(startedAtMs, Date.now()))')).toBe(true);
  });
});
