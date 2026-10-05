// Пункт [json-mode-was-asked-and-dropped] 2026-09-26 — поведенческая
// половина.
//
// Утверждение пункта — не «в коде есть реестр», а «запрос, который
// просит JSON, либо действительно просит его у провайдера, либо об этом
// сказано вслух». Поэтому здесь ВЫЗЫВАЕТСЯ клиент и смотрится ТЕЛО
// запроса, которое он отправил, и вызывается роутер и смотрится, что он
// сказал оператору. Файлы этот файл не читает намеренно: мера по дереву
// живёт в `audit-2026-09-26-json-mode-call-sites.spec.ts`, чтобы
// проверки поведения не смешивались с проверками текста исходника.

import { Logger } from '@nestjs/common';

import {
  AnthropicClient,
  OpenAiCompatibleClient,
  PROVIDERS_WITH_CLIENT,
  selectProviderClient,
} from '../ai-router/ai-provider-client';
import {
  JSON_MODE_BY_PROVIDER,
  JSON_MODE_NOT_DECIDED_HERE,
  checkJsonMode,
  jsonModeEnforced,
  jsonModeFact,
  promptAsksForJson,
} from '../ai-router/json-mode';
import { PERSON_TEXTS, failureText } from '../ai-router/failure-reason';
import { mediaFailureText } from '../media-review/media-review-auto.service';
import { withResponseLanguage } from '../common/ai-response-language';
import { AIRouterService } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { ContentScanService } from '../content-scan/content-scan.service';

/** Запоминает тело каждого исходящего запроса: вопрос «попросили ли
 * провайдера» отвечается только телом, а не флагом на входе. */
function captureFetch(body: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  (global as any).fetch = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return sent;
}

/** Что реестр говорит про провайдера, и что объявил его клиент.
 *
 * Обе — ОБЩАЯ машинерия пробы механизма и ключевых тестов. Проба,
 * потрогавшая только импортированный реестр, оставила бы ключевые тесты
 * без защиты: мутация «реестр из одних enforced» уронила бы её, но не
 * их. Сторож [probe-checked-the-neighbour] ловит ровно этот случай, и
 * поймал его здесь — в первой версии этой сверки. */
const registrySupport = (provider: string) => jsonModeFact(provider).support;
const clientSupport = (provider: string) => selectProviderClient(provider).jsonModeSupport;

const CREDENTIALS = { apiKey: 'sk-test', apiEndpoint: 'https://example.invalid/v1' };
const OPENAI_BODY = { choices: [{ message: { content: '[]' } }], usage: {} };
const ANTHROPIC_BODY = { content: [{ type: 'text', text: '[]' }], usage: {} };

describe('Пункт [json-mode-was-asked-and-dropped] 2026-09-26: формат ответа просят или говорят, что не просят', () => {
  it('проба механизма: реестр заполнен, и в нём есть ОБЕ стороны', () => {
    // Числа точные: реестр из одних 'enforced' сделал бы все проверки
    // ниже зелёными, ничего не проверив, — и то же наоборот.
    expect(JSON_MODE_BY_PROVIDER.length).toBe(4);
    const supports = PROVIDERS_WITH_CLIENT.map(registrySupport);
    expect(supports.filter((s) => s === 'enforced').length).toBe(2);
    expect(supports.filter((s) => s === 'prompt-only').length).toBe(2);
    expect(JSON_MODE_NOT_DECIDED_HERE.length).toBe(5);
    // У каждой строки — причина, а не констатация: «не задаём формат»
    // без причины читается как «недоделали», и следующий читатель
    // «доделает» это в прод-400.
    for (const fact of JSON_MODE_BY_PROVIDER) {
      expect(fact.why.length).toBeGreaterThan(40);
      expect(fact.how.length).toBeGreaterThan(10);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: клиент, объявивший enforced, КЛАДЁТ требование формата в тело запроса', async () => {
    const sent = captureFetch(OPENAI_BODY);
    await new OpenAiCompatibleClient().complete(
      { model: 'gpt-4.1', userPrompt: 'вопрос', jsonMode: true },
      CREDENTIALS,
    );
    expect(sent.length).toBe(1);
    // Объявление без тела — то же самое, что флаг без объявления.
    expect(sent[0].response_format).toEqual({ type: 'json_object' });
    expect(new OpenAiCompatibleClient().jsonModeSupport).toBe('enforced');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: клиент, объявивший prompt-only, действительно НИЧЕГО не кладёт', async () => {
    // Обратная сторона: если бы Anthropic однажды научили держать формат
    // и забыли поправить объявление, роутер продолжал бы предупреждать
    // на пустом месте — и наоборот, объявление 'enforced' без тела
    // заставило бы его молчать там, где надо говорить.
    const sent = captureFetch(ANTHROPIC_BODY);
    await new AnthropicClient().complete(
      { model: 'claude-sonnet-5', userPrompt: 'вопрос', jsonMode: true },
      CREDENTIALS,
    );
    expect(sent.length).toBe(1);
    expect(sent[0].response_format).toBeUndefined();
    expect(Object.keys(sent[0]).filter((k) => /format|mime|schema/i.test(k))).toEqual([]);
    expect(new AnthropicClient().jsonModeSupport).toBe('prompt-only');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр и объявления клиентов совпадают — у ВСЕХ провайдеров с клиентом', () => {
    // Ровно та болезнь, от которой заведены `lanes`: список рядом с
    // кодом, который надо держать в синхронности вручную. Проверяется не
    // «реестр непуст», а «реестр говорит то же, что клиент».
    const pairs = PROVIDERS_WITH_CLIENT.map((name) => [name, clientSupport(name), registrySupport(name)]);
    for (const [name, declared, registered] of pairs) {
      expect(`${name}: ${declared}`).toBe(`${name}: ${registered}`);
    }
    // И каждый провайдер с клиентом ОБЯЗАН быть в реестре: провайдер,
    // про которого неизвестно, держит ли он формат, — дыра, а не норма.
    expect(JSON_MODE_BY_PROVIDER.map((f) => f.provider).sort()).toEqual(
      [...PROVIDERS_WITH_CLIENT].sort(),
    );
  });

  it('КЛЮЧЕВОЙ ТЕСТ: незнакомый провайдер — ОШИБКА, а не «наверное, prompt-only»', () => {
    // Мягкий ответ по умолчанию выдал бы пробел за знание: роутер
    // промолчал бы о провайдере, про которого не знает ничего.
    expect(() => jsonModeFact('mistral')).toThrow(/не объявлен/);
    expect(jsonModeEnforced('openai')).toBe(true);
    expect(jsonModeEnforced('anthropic')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пробел объявляется только когда формат не запрошен НИ ОДНИМ каналом', () => {
    // Просьба словами — законный канал, и для Gemini единственный
    // (ТЗ §5). Кричать на 63 работающих сервиса значило бы приучить не
    // читать логи.
    expect(checkJsonMode('anthropic', 'Ответь валидным JSON вида {...}', 'текст').gap).toBeNull();
    expect(checkJsonMode('openai', 'без единого слова про формат', 'текст').gap).toBeNull();
    // А вот когда не просят ни параметром, ни словами — это пробел.
    const gap = checkJsonMode('anthropic', 'осторожная подсказка про страну', 'Страна: Польша.');
    expect(gap.gap === null).toBe(false);
    expect(gap.enforced).toBe(false);
    expect(gap.promptMentions).toBe(false);
    // Подсказка называет, ЧТО делать, а не только что плохо.
    expect(gap.gap).toMatch(/Допишите требование формата/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: упоминание формата ищется в ТЕКСТЕ, который реально уходит модели', () => {
    // Промпт бывает массивом блоков (медиа-полоса): требование формата
    // живёт в текстовом блоке, и не заметить его значило бы кричать на
    // каждом медиа-разборе.
    expect(
      promptAsksForJson(undefined, [
        { type: 'media', ref: { source: 'youtube', videoId: 'abc' } },
        { type: 'text', text: 'Відповідай СТРОГО валідним JSON вида {...}' },
      ]),
    ).toBe(true);
    expect(
      promptAsksForJson(undefined, [
        { type: 'media', ref: { source: 'youtube', videoId: 'abc' } },
        { type: 'text', text: 'Опиши разговор' },
      ]),
    ).toBe(false);
    expect(promptAsksForJson('Верни json-массив', 'текст')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: собственная приписка роутера о языке — НЕ просьба о формате', () => {
    // Первый прогон этой сверки провалился ровно здесь, и это была бы
    // главная ошибка пункта. Роутер дописывает к КАЖДОМУ промпту
    // приписку о языке ответа, а в ней есть «НЕ переводи и не изменяй:
    // ключи JSON». Наивная проверка зеленела бы на каждом вызове — не
    // нашла бы НИ ОДНОГО пробела и выглядела бы работающей.
    const appendixOnly = withResponseLanguage(undefined, 'ru');
    // Сначала — что приписка про JSON и правда говорит. Без этой строки
    // тест прошёл бы и в мире, где приписку переписали, и тогда он
    // проверял бы пустоту.
    expect(/json/i.test(appendixOnly)).toBe(true);
    expect(promptAsksForJson(appendixOnly, 'Страна: Польша.')).toBe(false);
    // Обратная сторона: текст ВЫЗЫВАЮЩЕГО, стоящий до приписки, под
    // проверкой остаётся — отрезается хвост, а не строка целиком.
    expect(promptAsksForJson(withResponseLanguage('Ответь валидным JSON', 'ru'), 'x')).toBe(true);
    // И весь путь целиком: пробел на провайдере без жёсткого режима.
    expect(checkJsonMode('anthropic', appendixOnly, 'Страна: Польша.').gap === null).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: роутер предупреждает оператора В МОМЕНТ ВЫЗОВА, назвав задачу и провайдера', async () => {
    // Место применения, а не чистая функция: главный промпт приходит из
    // базы, и проверить его можно только здесь. Мутация «убрать вызов
    // проверки из роутера» живёт ровно на этом шве.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const prisma = buildPrisma('anthropic', 'ANTHROPIC_API_KEY');
      captureFetch(ANTHROPIC_BODY);
      await buildRouter(prisma).execute({
        userId: 'user-1',
        taskType: 'religion-suggestion',
        systemPrompt: 'осторожная подсказка про распространённую религию',
        userPrompt: 'Страна: Польша.',
        jsonMode: true,
      });
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /jsonMode/.test(l));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/religion-suggestion/);
      expect(lines[0]).toMatch(/anthropic/);
    } finally {
      warn.mockRestore();
    }
  });

  it('обратная проба: когда формат просят словами — роутер молчит', async () => {
    // Без этой пробы предыдущий тест проходил бы и от предупреждения на
    // КАЖДОМ вызове, а такое предупреждение через неделю перестают
    // читать — то есть лечение оказалось бы хуже болезни.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const prisma = buildPrisma('anthropic', 'ANTHROPIC_API_KEY');
      captureFetch(ANTHROPIC_BODY);
      await buildRouter(prisma).execute({
        userId: 'user-1',
        taskType: 'religion-suggestion',
        systemPrompt: 'подсказка. Ответь СТРОГО валидным JSON вида {"a": string}',
        userPrompt: 'Страна: Польша.',
        jsonMode: true,
      });
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /jsonMode/.test(l))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: оператору при провале валидации сказано, каким каналом был задан формат', () => {
    // Раньше в логе стояло «выход не прошёл валидацию схемы», из чего не
    // следовало ничего: формат могли не запросить вовсе, а могли
    // запросить жёстко — это разные починки.
    expect(checkJsonMode('openai', 'без слова про формат', 'x').note).toMatch(/задан жёстко/);
    expect(checkJsonMode('anthropic', 'Ответь JSON', 'x').note).toMatch(/жёстко не задан.*упоминает/);
    expect(checkJsonMode('anthropic', 'ничего', 'x').note).toMatch(/не задан ни одним каналом/);
    expect(failureText('schema-invalid-no-format', 'выход не прошёл').operator).toMatch(
      /^schema-invalid-no-format:/,
    );
  });

  it('КЛЮЧЕВОЙ ТЕСТ: при ПОСТАНОВКЕ фоновой задачи оператор предупреждён — до отправки, не после провала', async () => {
    const { res, logged } = await submitBackground('осторожная подсказка про распространённую религию');
    // Задача всё же отправлена: пробел настройки — не причина ломать то,
    // что может сработать. Но промолчать о нём нельзя: молчание и есть
    // сам дефект.
    expect(res.submitted).toBe(1);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(/religion-suggestion/);
    expect(logged[0]).toMatch(/не сказано ни слова/);
  });

  it('обратная проба постановки: формат просили словами — при отправке тихо', async () => {
    const { res, logged } = await submitBackground('подсказка. Ответь СТРОГО валидным JSON вида {"a": string}');
    expect(res.submitted).toBe(1);
    expect(logged).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: на фоновой полосе человек ПОЛУЧАЕТ честный текст, а не совет менять материал', async () => {
    // Мутация «выбирать прежний вид провала всегда» пережила первую
    // версию этой сверки: текст проверялся сам по себе, а место его
    // выбора — нет. Здесь прогоняется вся полоса: постановка, ответ
    // провайдера, провал валидации, — и читается то поле, которое рисует
    // экран человека (`partialResult`).
    const { job, logged } = await failedBackgroundRun('осторожная подсказка про распространённую религию');
    expect(job.status).toBe('FAILED');
    expect(String(job.partialResult)).toMatch(/не из-за ваших материалов/);
    expect(/фрагмент/.test(String(job.partialResult))).toBe(false);
    // А оператору — В ЛОГ — сказано, каким каналом формат был задан.
    // Раньше там стояло «выход не прошёл валидацию схемы», из чего не
    // следовало ни одной следующей мысли.
    const operator = logged.filter((l) => /провалена/.test(l)).join('\n');
    expect(operator).toMatch(/не задан ни одним каналом/);
    expect(operator).toMatch(/response_mime_type/);
    // И машинная подробность осталась в логе, а не ушла человеку.
    expect(/response_mime_type/.test(String(job.partialResult))).toBe(false);
  });

  it('обратная проба фоновой полосы: когда формат просили словами — текст остаётся прежним', async () => {
    // Иначе предыдущий тест проходил бы и в мире, где новый текст
    // отдают ВСЕГДА, — а это значило бы говорить «дело в нашей
    // настройке» там, где настройка в порядке.
    const { job, logged } = await failedBackgroundRun('подсказка. Ответь СТРОГО валидным JSON вида {"a": string}');
    expect(job.status).toBe('FAILED');
    expect(String(job.partialResult)).toMatch(/фрагмент/);
    expect(/не из-за ваших материалов/.test(String(job.partialResult))).toBe(false);
    // Оператору — другая половина той же правды: жёстко не задан, но
    // словами просили. Это разные починки, и различить их должно быть
    // можно по одной строке лога.
    const operator = logged.filter((l) => /провалена/.test(l)).join('\n');
    expect(operator).toMatch(/жёстко не задан/);
    expect(operator).toMatch(/упоминает/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: человеку не говорят «дело в ваших материалах», когда формат не просили', () => {
    // Совет «попробуйте другой фрагмент» отправляет человека чинить свой
    // материал вместо нашей настройки. Это не просто бесполезный совет:
    // это перекладывание собственного пробела на него.
    const notAsked = PERSON_TEXTS['schema-invalid-no-format'];
    expect(notAsked === PERSON_TEXTS['schema-invalid']).toBe(false);
    expect(notAsked).toMatch(/не из-за ваших материалов/);
    expect(notAsked).toMatch(/Повторять смысла нет/);
    expect(/фрагмент/.test(notAsked)).toBe(false);
    // Обратная сторона: там, где формат ЗАДАН жёстко и ответ всё равно
    // не разобрался, материал — законная гипотеза, и текст остаётся.
    expect(PERSON_TEXTS['schema-invalid']).toMatch(/фрагмент/);
    // И подсказка «в ролике мало внятной речи» к этому виду НЕ
    // приклеивается: причина известна точно, и она не в звуке. Иначе
    // человек получил бы и честное «дело в нашей настройке», и совет
    // менять ролик — в одном абзаце.
    expect(mediaFailureText(notAsked, 'schema-invalid-no-format')).toBe(notAsked);
    expect(mediaFailureText(PERSON_TEXTS['schema-invalid'], 'schema-invalid') === PERSON_TEXTS['schema-invalid']).toBe(false);
    // И ни один текст человеку не несёт внутренних имён.
    for (const text of Object.values(PERSON_TEXTS)) {
      expect(/jsonMode|response_format|validateOutput/.test(text)).toBe(false);
    }
  });
});

// ── фейковое окружение роутера ────────────────────────────────────
// Своё, а не общее с `ai-router.service.spec.ts`: там фейк настроен под
// OpenAI, а весь смысл этих проверок — в провайдере, который формат не
// держит.
function buildPrisma(providerName: string, credentialRef: string) {
  const jobs = new Map<string, any>();
  let n = 0;
  const id = () => `id-${++n}`;
  const modelVersion = {
    id: 'mv-1',
    version: 'model-1',
    model: { name: 'model-1', provider: { name: providerName, apiEndpoint: 'https://example.invalid', credentialRef } },
  };
  return {
    _jobs: jobs,
    user: { findUnique: async () => ({ languageCode: 'ru' }) },
    // Фоновая полоса забирает джобы сырым запросом; какие именно —
    // подставляет тест.
    $queryRaw: async (): Promise<Array<{ id: string }>> => [...jobs.keys()].map((k) => ({ id: k })),
    project: { findUnique: async () => ({ frozenAt: null }) },
    aIJob: {
      count: async () => 0,
      findFirst: async () => null,
      findMany: async (): Promise<any[]> => [],
      create: async ({ data }: any) => { const j = { id: id(), retryCount: 0, ...data }; jobs.set(j.id, j); return j; },
      update: async ({ where, data }: any) => { const j = { ...jobs.get(where.id), ...data }; jobs.set(where.id, j); return j; },
      findUniqueOrThrow: async ({ where }: any) => ({ ...jobs.get(where.id), modelVersion }),
    },
    aIModelVersion: { findUnique: async () => null },
    aIModelCapability: {
      findMany: async () => [{ modelVersionId: 'mv-1', availability: 'active', modelVersion }],
    },
    aIInference: { create: async ({ data }: any) => ({ id: id(), ...data }) },
    consentRecord: {
      // Пункт [the-first-row-was-whichever] 2026-10-05: согласие считается
      // по ВСЕМ действующим записям — заглушка обязана знать `findMany`.
      findFirst: async () => ({ id: 'c-1', granted: true, revokedAt: null }),
      findMany: async () => [{ id: 'c-1', granted: true, revokedAt: null }],
    },
    contentScanResult: { create: async ({ data }: any) => ({ id: id(), ...data }), updateMany: async () => ({ count: 1 }) },
    contentScanDetection: { create: async ({ data }: any) => ({ id: id(), ...data }) },
  };
}

/** Постановка фоновой задачи провайдеру: что при этом увидел оператор.
 *
 * Отдельно от прогона до провала: предупреждение о пробеле обязано
 * прозвучать В МОМЕНТ ОТПРАВКИ, а не только после того, как ответ уже
 * не разобрался. Мутация «убрать проверку из постановки» живёт ровно
 * здесь. */
async function submitBackground(systemPrompt: string) {
  const logged: string[] = [];
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((message: unknown) => { logged.push(String(message)); });
  const prisma = buildPrisma('google', 'GEMINI_API_KEY');
  const router = buildRouter(prisma);
  await router.enqueue({
    userId: 'user-1',
    taskType: 'religion-suggestion',
    systemPrompt,
    userPrompt: 'Страна: Польша.',
    jsonMode: true,
  });
  const accepted = { id: 'int-1', status: 'in_progress' };
  (global as any).fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => accepted,
    text: async () => JSON.stringify(accepted),
  });
  const res = await router.submitQueued(3);
  warn.mockRestore();
  return { res, logged: logged.filter((l) => /jsonMode/.test(l)) };
}

/** Один прогон фоновой полосы: поставить задачу, довести её до
 * «completed» с невалидным выходом и вернуть то, что увидел человек.
 *
 * Именно вживую, а не через чистую функцию: выбор текста человеку живёт
 * В РОУТЕРЕ, и мутация «отдать прежний текст» переживает любую проверку
 * самого текста. */
async function failedBackgroundRun(systemPrompt: string) {
  // Операторская половина ловится здесь же: она уходит в ЛОГ, и
  // проверить её можно только перехватив лог.
  const logged: string[] = [];
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((message: unknown) => { logged.push(String(message)); });
  const prisma = buildPrisma('google', 'GEMINI_API_KEY');
  const router = buildRouter(prisma);
  // Валидатор фоновой задачи живёт в реестре по taskType — выход не
  // пройдёт его никогда, а весь вопрос в том, ЧТО из этого скажут.
  router.registerOutputValidator('religion-suggestion', () => false);
  const { jobId } = await router.enqueue({
    userId: 'user-1',
    taskType: 'religion-suggestion',
    systemPrompt,
    userPrompt: 'Страна: Польша.',
    jsonMode: true,
  });
  await prisma.aIJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', externalInteractionId: 'int-1', retryCount: 9 },
  });
  const done = { id: 'int-1', status: 'completed', output_text: 'обычная проза без всякого JSON' };
  (global as any).fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => done,
    text: async () => JSON.stringify(done),
  });
  await router.pollRunning(10);
  warn.mockRestore();
  return { job: prisma._jobs.get(jobId), logged };
}

function buildRouter(prisma: any) {
  return new AIRouterService(
    prisma as any,
    { resolve: async () => 'sk-test' } as any,
    new ConsentService(prisma as any),
    new ContentScanService(prisma as any),
    { resolve: async () => ({ uri: 'https://example.invalid/x' }) } as any,
  );
}
