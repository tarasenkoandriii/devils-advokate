// Сверка длинных разговоров 2026-09-04 — тупик, который я сделал сам.
//
// Заход [input-limits] (2026-09-03) поставил общий потолок длины запроса к
// модели: 120 000 символов, «заведомо больше любого честного серверного
// промпта проекта». Число выбиралось по самому длинному промпту В КОДЕ
// (сверка вариантов CV, 24 000). Транскрипт в коде не виден: его длину
// задаёт человек, который записал разговор.
//
// Посчитано: час живой речи ≈ 54 000 символов текста плюс служебные части
// строк — около 77 000 символов промпта. Полтора часа — 116 000, ещё
// проходит. 105 минут — 135 000, ОТКАЗ. Три часа — 232 000, ОТКАЗ. При
// этом загрузка принимает файл до 500 МБ, расшифровка этих часов
// оплачивается, а на разборе человек получал «слишком длинный текст,
// сократите» — сократить записанный разговор нельзя.
//
// Двухчасовые переговоры и трёхчасовой семейный разговор — не крайний
// случай этого продукта, а тот, ради которого его открывают.
//
// Тест держит три вещи: длинный разговор разбирается (а не отказывает),
// разбирается ЦЕЛИКОМ (ни одна реплика не выброшена), и человеку сказано,
// что разбор шёл частями и чего такой разбор не увидит.

import { chunkSegments, chunkedAnalysisNotice, estimateMinutes, CHUNK_BUDGET_CHARS } from '../common/transcript-chunks';
import { MAX_USER_PROMPT_CHARS } from '../ai-router/prompt-limits';
import { TurningPointsService } from '../turning-points/turning-points.service';
import { ManipulationDetectorService } from '../manipulation-detector/manipulation-detector.service';
import { DoNotSayService } from '../do-not-say/do-not-say.service';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

/** Реплики примерно как у настоящей расшифровки: одна фраза на 6 секунд,
 * 90 символов текста. `minutes` минут разговора. */
function speech(minutes: number) {
  const count = Math.round((minutes * 60) / 6);
  return Array.from({ length: count }, (_, i) => ({
    id: `cmf3k2l9x${String(i).padStart(4, '0')}abcdefghijkl`,
    participantId: 'part-1',
    text: `Реплика номер ${i}, ` + 'слова разговора '.repeat(4),
    participant: { diarizationLabel: i % 2 ? 'B' : 'A', isSelf: i % 2 === 0 },
  }));
}

/** Тот же фейк, но под любой из трёх детекторов: у всех одна форма —
 * разговор с транскриптом, роутер, запись сигналов. */
function detectorFake(segments: ReturnType<typeof speech>, kind: 'turning' | 'manipulation' | 'do-not-say') {
  const base = turningPointsFake(segments);
  if (kind === 'turning') return base;
  const router = (base as any).router;
  const prisma = (base as any).prismaHandle;
  const svc =
    kind === 'manipulation'
      ? new ManipulationDetectorService(prisma, router)
      : new DoNotSayService(prisma, router);
  return { ...base, svc: svc as any };
}

function turningPointsFake(segments: ReturnType<typeof speech>) {
  const prompts: string[] = [];
  const signals: any[] = [];
  const conversation: any = {
    id: 'conv-1',
    projectId: 'p-1',
    status: 'TRANSCRIBED',
    project: { id: 'p-1', ownerId: 'u-1' },
    transcript: { id: 'tr-1', segments },
  };
  const prisma: any = {
    conversation: {
      findUnique: async () => conversation,
      update: async ({ data }: any) => {
        Object.assign(conversation, data);
        return conversation;
      },
    },
    promptVersion: { findFirst: async () => null },
    conversationSignal: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        const row = { id: `sig-${signals.length + 1}`, ...data };
        signals.push(row);
        return row;
      },
    },
    conversationSignalEvidence: { create: async ({ data }: any) => data },
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  };
  const aiRouter: any = {
    execute: async (req: any) => {
      prompts.push(req.userPrompt);
      // Модель находит по одной точке в каждой части — на первой реплике
      // этой части. Так видно, что все части реально дошли до модели.
      const firstId = /\[(\S+)\]/.exec(req.userPrompt)?.[1] ?? '';
      return {
        text: JSON.stringify([
          { segmentId: firstId, signalType: 'EMOTIONAL_SHIFT', description: 'перелом', confidence: 0.7 },
        ]),
        aiInferenceId: `inf-${prompts.length}`,
        jobId: `job-${prompts.length}`,
      };
    },
  };
  return {
    svc: new TurningPointsService(prisma, aiRouter),
    prompts,
    signals,
    conversation,
    prismaHandle: prisma,
    router: aiRouter,
  };
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('ИЗМЕРЕНИЕ: до правки трёхчасовой разговор не проходил потолок — и это главный случай продукта', async () => {
    const segments = speech(180);
    const onePrompt = segments
      .map((s) => `[${s.id}] ${s.participant.diarizationLabel}: ${s.text}`)
      .join('\n');
    assertEqual(
      onePrompt.length > MAX_USER_PROMPT_CHARS,
      true,
      `три часа разговора это ${onePrompt.length} символов при потолке ${MAX_USER_PROMPT_CHARS}`,
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: трёхчасовой разговор разбирается, а не отказывает', async () => {
    const segments = speech(180);
    const f = turningPointsFake(segments);

    const { points, notice } = await f.svc.detect('u-1', 'conv-1');

    assertEqual(f.prompts.length > 1, true, `разбор пошёл частями (частей: ${f.prompts.length})`);
    assertEqual(points.length, f.prompts.length, 'находки собраны со ВСЕХ частей, а не только с первой');
    assertEqual(f.conversation.status, 'ANALYZED', 'разговор доведён до конца, а не оставлен в ANALYZING');
    assertEqual(notice !== null, true, 'человеку сказано, что разбор шёл частями');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: ни одна реплика не потеряна при разбивке', async () => {
    // Молчаливая потеря куска здесь была бы хуже отказа: разбор
    // выглядел бы полным.
    const segments = speech(180);
    const f = turningPointsFake(segments);
    await f.svc.detect('u-1', 'conv-1');

    const all = f.prompts.join('\n');
    const missing = segments.filter((s) => !all.includes(s.id));
    assertEqual(missing.length, 0, `реплик не дошло до модели: ${missing.length}`);
  });

  test('КЛЮЧЕВОЙ ТЕСТ: каждая часть по отдельности проходит потолок роутера', async () => {
    // Иначе разбивка была бы декоративной: части ушли бы в роутер и там
    // же и отказали.
    const f = turningPointsFake(speech(180));
    await f.svc.detect('u-1', 'conv-1');
    const tooLong = f.prompts.filter((p) => p.length > MAX_USER_PROMPT_CHARS);
    assertEqual(tooLong.length, 0, 'ни одна часть не упирается в потолок');
  });

  test('подпись говорит, ЧЕГО разбор частями не увидит — иначе «разобрано» читалось бы как «разобрано целиком»', async () => {
    const notice = chunkedAnalysisNotice(3, 180) ?? '';
    assertEqual(/по частям/.test(notice), true, 'сказано, что частями');
    // `\w` в JS — это только латиница, поэтому по кириллице ищем прямо
    // подстрокой: тест не должен проходить из-за особенностей regexp.
    assertEqual(notice.includes('началом и концом разговора'), true, 'названа именно потерянная связь начала с концом');
    assertEqual(/ничего не отброшено/.test(notice), true, 'и сказано, что реплики не выброшены');
  });

  test('короткий разговор идёт одним куском и подписи не получает', async () => {
    const f = turningPointsFake(speech(10));
    const { notice } = await f.svc.detect('u-1', 'conv-1');
    assertEqual(f.prompts.length, 1, 'десять минут — один запрос');
    assertEqual(notice, null, 'подписи нет: иначе она стояла бы всегда и перестала бы значить что-либо');
  });

  test('реплика никогда не делится между частями — половина фразы это уже искажение слов человека', async () => {
    const segments = speech(120);
    const chunks = chunkSegments(segments, (s) => `[${s.id}] ${s.text}`);
    const ids = chunks.flat().map((s) => s.id);
    assertEqual(ids.length, segments.length, 'сумма частей равна целому');
    assertEqual(new Set(ids).size, segments.length, 'ни одна реплика не попала в две части');
  });

  test('бюджет части оставляет запас под системный промпт и контекст, а не равен потолку', async () => {
    assertEqual(CHUNK_BUDGET_CHARS < MAX_USER_PROMPT_CHARS, true, 'бюджет меньше потолка');
    assertEqual(estimateMinutes(54_000), 60, 'час речи оценивается как час — оценка, но не выдуманная');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: два других детектора того же класса тоже разбирают трёхчасовой разговор', async () => {
    // Механика общая, но проверяется у каждого: «работает у соседа» — не
    // доказательство, а именно та подмена, которую ловила мутационная
    // сверка. У do-not-say свой список реплик (только сам пользователь),
    // поэтому и подпись у него считается по ним же.
    const manip = detectorFake(speech(180), 'manipulation');
    const manipResult = await manip.svc.detect('u-1', 'conv-1');
    assertEqual(manip.prompts.length > 1, true, 'манипулятивные приёмы: разбор пошёл частями');
    assertEqual(manipResult.notice !== null, true, 'манипулятивные приёмы: подпись есть');

    const dns = detectorFake(speech(180), 'do-not-say');
    const dnsResult = await dns.svc.detect('u-1', 'conv-1');
    assertEqual(dns.prompts.length > 1, true, '«не стоило говорить»: разбор пошёл частями');
    assertEqual(dnsResult.notice !== null, true, '«не стоило говорить»: подпись есть');
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
  console.log(`\nДлинные разговоры: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
