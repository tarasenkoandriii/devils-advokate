// Сверка «ссылка на реплику» 2026-09-04 — проверяется ли, что источник
// существует.
//
// Пять доменных разборов (health, family-law, investment, dtp,
// interview-pool-relevance) сохраняли `sourceSegmentId` из ответа модели
// как есть. У interview-pool это видно яснее всего: правило §4.3
// «позиция кандидата не сохраняется без реплики-источника» проверяло, что
// поле НЕ ПУСТОЕ — выдуманный идентификатор проходил его насквозь и
// ложился в лист условий как доказательство. Два сервиса того же класса
// (turning-points, manipulation-detector) сверку с реальными репликами
// делали с самого начала: правило в проекте было, но не везде.
//
// Теперь реплики уходят модели под номерами, а номер переводится обратно
// в настоящий id. Выдумать «номер 900» в разговоре из трёх реплик модель
// по-прежнему может — но такая выдумка ВИДНА и отбрасывается.
//
// Файл в стиле самостоятельного раннера: спеки соседних доменов написаны
// так же, и запускать их одним способом важнее единообразия с jest.

import { numberedTranscript, resolveSegmentRef } from '../common/transcript-prompt';
import { HealthService } from '../health/health.service';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const SEGMENTS = [
  { id: 'cmf3k2l9x0001abcdefghijkl', text: 'Операция нужна в ближайший месяц.' },
  { id: 'cmf3k2l9x0002abcdefghijkl', text: 'Восстановление занимает недели три.' },
  { id: 'cmf3k2l9x0003abcdefghijkl', text: 'Альтернатива — консервативное лечение.' },
];

/** Фейк health-разбора: важна только цепочка «промпт → ответ модели →
 * что сохранилось». */
function healthSetup(modelAnswer: unknown) {
  const consultation = {
    id: 'cons-1',
    conversationId: 'conv-1',
    draftedAt: null,
    reviewedAt: new Date(),
    provider: { configId: 'cfg-1', config: { projectId: 'p-1' } },
  };
  let saved: any = null;
  let capturedPrompt = '';
  const prisma: any = {
    project: { findFirst: async () => ({ id: 'p-1', ownerId: 'u-1' }) },
    healthConsultation: {
      findUnique: async () => consultation,
      update: async ({ data }: any) => {
        saved = data;
        return { ...consultation, ...data };
      },
    },
    healthQuizCriterion: {
      findMany: async () => [{ id: 'crit-1', category: 'RISK', text: 'Риски операции', isRequired: true }],
    },
    transcriptSegment: { findMany: async () => SEGMENTS },
  };
  const aiRouter: any = {
    execute: async (req: any) => {
      capturedPrompt = req.userPrompt;
      return { text: JSON.stringify(modelAnswer), aiInferenceId: 'inf-1', jobId: 'job-1' };
    },
  };
  const svc = new HealthService(prisma, aiRouter, {} as any, {} as any);
  return { svc, saved: () => saved, prompt: () => capturedPrompt };
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('КЛЮЧЕВОЙ ТЕСТ: выдуманная моделью ссылка на реплику НЕ сохраняется как источник', async () => {
    const s = healthSetup({
      criteriaBreakdown: [
        { criterionId: 'crit-1', whatWasSaid: 'Врач назвал сроки', sourceSegmentId: '900' },
      ],
    });
    await s.svc.generateBreakdown('u-1', 'cons-1');
    const breakdown = s.saved().criteriaBreakdown;
    assertEqual(breakdown.length, 1, 'сам разбор сохранён — теряется ссылка, а не содержание');
    assertEqual(breakdown[0].sourceSegmentId, null, 'несуществующая ссылка обнулена, а не сохранена');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: настоящая ссылка сохраняется настоящим id реплики, а не номером', async () => {
    const s = healthSetup({
      criteriaBreakdown: [
        { criterionId: 'crit-1', whatWasSaid: 'Врач назвал сроки', sourceSegmentId: '2' },
      ],
    });
    await s.svc.generateBreakdown('u-1', 'cons-1');
    assertEqual(
      s.saved().criteriaBreakdown[0].sourceSegmentId,
      SEGMENTS[1].id,
      'номер 2 переведён в id второй реплики',
    );
  });

  test('в промпт уходят номера, а не cuid — иначе экономия исчезнет молча', async () => {
    const s = healthSetup({ criteriaBreakdown: [] });
    await s.svc.generateBreakdown('u-1', 'cons-1');
    assertEqual(/\[1\] Операция нужна/.test(s.prompt()), true, 'реплики пронумерованы');
    assertEqual(s.prompt().includes(SEGMENTS[0].id), false, 'cuid реплики в промпт не уходит');
  });

  test('текст ссылки терпим к форме: «[2]», « 2 » и 2 — одна и та же реплика', async () => {
    const { byRef } = numberedTranscript(SEGMENTS);
    for (const raw of ['[2]', ' 2 ', 2]) {
      assertEqual(resolveSegmentRef(byRef, raw), SEGMENTS[1].id, `форма ${JSON.stringify(raw)}`);
    }
  });

  test('но нетерпим к содержанию: чужой cuid, ноль, пустая строка и мусор — это «источника нет»', async () => {
    const { byRef } = numberedTranscript(SEGMENTS);
    for (const raw of ['cmf3k2l9x0009abcdefghijkl', '0', '', '   ', 'вторая реплика', null, undefined]) {
      assertEqual(resolveSegmentRef(byRef, raw), null, `мусор ${JSON.stringify(raw)}`);
    }
  });

  test('экономия измерима: идентификаторы занимали больше трети такого промпта', async () => {
    // Не «стало лучше», а сколько именно. Прежний формат — `[id=<cuid>] `
    // на каждую реплику: 25 символов cuid плюс 6 обёртки. Новый — `[7] `,
    // то есть 4 символа на первых девяти репликах. Разница — 27.
    const { text, savedChars } = numberedTranscript(SEGMENTS);
    const oldLength = text.length + savedChars;
    const share = savedChars / oldLength;
    assertEqual(savedChars, 3 * 27, 'сэкономлено ровно по 27 символов на реплику');
    assertEqual(share > 0.33, true, `доля служебных символов в прежнем промпте: ${(share * 100).toFixed(0)}%`);
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
  console.log(`\nСсылка на реплику: ${results.length - failed.length}/${results.length} passed\n`);
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
