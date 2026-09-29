// Сверка черновиков 2026-09-04 — долг, записанный в тесте со сроком.
//
// Сверка [dropped-quotes] закрыла шесть мест и одно оставила, назвав
// поимённо и в коде, и в проверке: `proposeClauses` / `proposePositions`,
// «первый пункт следующей сверки». Это она. Список исключений в
// `audit-2026-09-04-dropped-quotes` теперь пуст — срок оказался
// настоящим, а не формальностью.
//
// ЧТО ЗДЕСЬ ОКАЗАЛОСЬ СЛОЖНЕЕ, ЧЕМ В ПРОШЛЫЙ РАЗ. Там причина была одна
// («цитаты нет в источнике») и число одно. Здесь причин ЧЕТЫРЕ, и они
// значат для человека разное:
//   • нет опоры на его текст — модель предложила то, чего он не говорил;
//   • ссылка на пункт, которого в листе нет — модель придумала пункт;
//   • ответ не той формы — сбой разбора, к человеку отношения не имеющий;
//   • упёрлись в потолок 40 — ЕДИНСТВЕННАЯ причина, где ему есть что
//     сделать: разбить текст на части.
// Свести их в одно число значило бы отнять у него это действие. Поэтому
// причины считаются порознь и порознь же доходят до экрана.
//
// ПЯТЫЙ СЛУЧАЙ — ДУБЛЬ — СЧИТАЕТСЯ ОТДЕЛЬНО И ПОТЕРЕЙ НЕ ЯВЛЯЕТСЯ:
// вторая позиция по тому же пункту отброшена, но первая сохранена, о
// пункте человек узнал. Приписать дубль к потерям — та же неправда, что
// и молчать о них, только в другую сторону. Тест держит и это.
//
// ГДЕ МОЛЧАНИЕ СТОИЛО ДОРОЖЕ ВСЕГО, и почему заход вообще не про
// «аккуратность»:
//   • тестовое задание: требование, чью позицию не удалось разобрать,
//     показывалось как `unknown` — «в ответе не отражено». Недоработка
//     разбора выдавалась за СУЖДЕНИЕ О РАБОТЕ КАНДИДАТА;
//   • репетиция: тот же пункт попадал в `floating` — «не закрыто вашими
//     словами», то есть утверждение о человеке;
//   • разбор оффера: потерянное условие читалось как «в оффере этого
//     нет» — и по этому списку человек решает, соглашаться ли.
//
// ВТОРОЕ ОТБРАСЫВАНИЕ, КОТОРОГО НЕ ИСКАЛИ. Потолок `MAX_CLAUSES_PER_TEXT`
// молча срезал хвост списка — та самая «обрезка без подписи», которую
// проект уже закрывал в других местах. Здесь она пряталась за соседним
// фильтром и в прошлый заход не попалась.

import { TermsMatchingService, sanitizePositionDraft, emptySkips, lostDrafts, MAX_CLAUSES_PER_TEXT } from '../terms-sheet/terms-matching.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { HiringExtrasService } from '../hiring-extras/hiring-extras.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

const VACANCY = `Sales-менеджер
Обязательно: опыт B2B-продаж от 2 лет.
Условия: удалённо, оплата 1000-1500 USD.`;

function setup(handler: (req: any) => string) {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  return { prisma, router, matching, sheets };
}

function seedSheet(prisma: any) {
  const project = prisma.seed('project', { ownerId: 'u', mode: 'JOB_SEARCH' });
  const sheet = prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY', title: 'т' });
  return { project, sheet };
}

describe('Черновики: что модель предложила и что из этого не сохранено', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: пункты без опоры на текст считаются, а не исчезают', async () => {
    const s = setup(() =>
      JSON.stringify({
        clauses: [
          { kind: 'REQUIREMENT', text: 'Опыт B2B-продаж от 2 лет', category: 'опыт', isRequired: true, quote: 'опыт B2B-продаж от 2 лет' },
          { kind: 'CONDITION', text: 'Удалённо', category: 'формат', isRequired: false, quote: 'удалённо' },
          { kind: 'REQUIREMENT', text: 'Английский C1', category: 'язык', isRequired: true, quote: 'английский C1 обязателен' },
          { kind: 'REQUIREMENT', text: 'Права категории B', category: 'прочее', isRequired: false, quote: 'водительские права' },
        ],
      }),
    );
    const { project, sheet } = seedSheet(s.prisma);
    const out = await s.matching.proposeClauses({
      userId: 'u',
      projectId: project.id,
      sheetId: sheet.id,
      side: 'EMPLOYER' as any,
      text: VACANCY,
      evidenceKind: 'VACANCY_TEXT' as any,
      evidenceRef: null,
      scenario: 'тест',
    });

    expect(out.created).toHaveLength(2);
    expect(out.skipped.withoutQuote).toBe(2);
    expect(out.skipped.overLimit).toBe(0);
    expect(lostDrafts(out.skipped)).toBe(2);
    // И выдуманное действительно не сохранено — считать считаем, показывать нельзя.
    expect(s.prisma.rows('termsClause').map((c: any) => c.text).sort()).toEqual(['Опыт B2B-продаж от 2 лет', 'Удалённо']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок в 40 пунктов больше не срезает хвост молча — и человеку сказано, что делать', async () => {
    // Второе отбрасывание, которое пряталось за первым. Обрезка без
    // подписи — форма, которую проект уже закрывал в других местах.
    const text = Array.from({ length: 50 }, (_, i) => `строка номер ${i}`).join('\n');
    const s = setup(() =>
      JSON.stringify({
        clauses: Array.from({ length: 50 }, (_, i) => ({ kind: 'REQUIREMENT', text: `Пункт ${i}`, category: 'x', isRequired: false, quote: `строка номер ${i}` })),
      }),
    );
    const { project, sheet } = seedSheet(s.prisma);
    const out = await s.matching.proposeClauses({
      userId: 'u',
      projectId: project.id,
      sheetId: sheet.id,
      side: 'EMPLOYER' as any,
      text,
      evidenceKind: 'VACANCY_TEXT' as any,
      evidenceRef: null,
      scenario: 'тест',
    });

    expect(out.created).toHaveLength(MAX_CLAUSES_PER_TEXT);
    expect(out.skipped.overLimit).toBe(50 - MAX_CLAUSES_PER_TEXT);
    // Обрезка — НЕ «без опоры»: причины не должны сливаться, иначе
    // человек не поймёт, что от него зависит.
    expect(out.skipped.withoutQuote).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у позиций каждая причина считается своей, и дубль потерей НЕ считается', async () => {
    const s = setup((req: any) => {
      if (req.taskType === 'terms-match') {
        const ids = [...req.userPrompt.matchAll(/\[id=([^\]]+)\]/g)].map((m: any) => m[1]);
        return JSON.stringify({
          positions: [
            // нормальная
            { clauseId: ids[0], coverage: 'covered', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'опыт B2B-продаж от 2 лет' },
            // дубль по тому же пункту — первая сохранена, потери нет
            { clauseId: ids[0], coverage: 'partial', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'удалённо' },
            // выдуманный пункт
            { clauseId: 'не-существует', coverage: 'covered', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'удалённо' },
            // цитаты в тексте нет
            { clauseId: ids[1], coverage: 'covered', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'этого в вакансии нет' },
            // опора есть, а coverage не из списка — другая причина
            { clauseId: ids[2], coverage: 'выдумано', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'удалённо' },
          ],
        });
      }
      return '{}';
    });
    const { project, sheet } = seedSheet(s.prisma);
    for (const [i, text] of ['Опыт', 'Английский', 'Права'].entries()) {
      s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text, orderIndex: i, confirmedAt: new Date() });
    }

    const out = await s.matching.proposePositions({
      userId: 'u',
      projectId: project.id,
      sheetId: sheet.id,
      bySide: 'CANDIDATE' as any,
      input: { text: VACANCY, evidenceKind: 'VACANCY_TEXT' as any, evidenceRef: null },
      scenario: 'тест',
    });

    expect(out.created).toHaveLength(1);
    expect(out.skipped).toEqual({ withoutQuote: 1, unknownClause: 1, malformed: 1, duplicateClause: 1, overLimit: 0 });
    // Дубль не потеря: позиция по этому пункту у человека есть.
    expect(lostDrafts(out.skipped)).toBe(3);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: причина отказа названа, а не сведена к «не получилось»', () => {
    // Прежняя версия возвращала `null` на все шесть случаев, и вызывающий
    // не мог отличить «модель сослалась на то, чего вы не говорили» от
    // «модель ответила не по форме».
    const clause = { id: 'c', kind: 'REQUIREMENT' as any };
    // Пункт [finding-without-substance-2] 2026-09-26: у каждого случая
    // здесь своя причина, и остальные поля заполнены НАРОЧНО. Раньше во
    // всех трёх стояло `note: ''` — тогда это было безразлично, а после
    // того как пустое изложение стало причиной отказа, `badCoverage`
    // зеленел бы по НЕ ТОЙ причине (счётчик у них общий, и подмену было
    // бы нечем заметить).
    const NOTE = 'нейтральное изложение позиции';
    const noQuote = sanitizePositionDraft({ clauseId: 'c', coverage: 'covered', stance: null, note: NOTE, evidenceRef: null, evidenceQuote: '' }, clause, { sourceText: 'текст' });
    const badCoverage = sanitizePositionDraft({ clauseId: 'c', coverage: 'нет-такого' as any, stance: null, note: NOTE, evidenceRef: null, evidenceQuote: 'текст' }, clause, { sourceText: 'текст' });
    const emptyNote = sanitizePositionDraft({ clauseId: 'c', coverage: 'covered', stance: null, note: '   ', evidenceRef: null, evidenceQuote: 'текст' }, clause, { sourceText: 'это текст' });
    expect(noQuote).toEqual({ rejected: 'withoutQuote' });
    expect(badCoverage).toEqual({ rejected: 'malformed' });
    // Черновик без изложения позиции — тоже отказ, а не запись с пустым
    // полем: дальше по пути `note` только обрезается до 600 знаков.
    expect(emptyNote).toEqual({ rejected: 'malformed' });
    // Успешный разбор причиной не помечается — иначе ветка `'rejected' in`
    // молча съедала бы годные черновики.
    const ok = sanitizePositionDraft({ clauseId: 'c', coverage: 'covered', stance: null, note: NOTE, evidenceRef: null, evidenceQuote: 'текст' }, clause, { sourceText: 'это текст' });
    expect('rejected' in ok).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: тестовое задание отличает «в ответе не отражено» от «мы не разобрали»', async () => {
    // Самое дорогое молчание домена: `unknown` в колонке требования
    // читается как суждение о работе кандидата, а мог означать сбой
    // разбора. Два потока потерь названы порознь — чеклист неполон и
    // вывод отсутствует это разные пробелы.
    const s = setup((req: any) => {
      if (req.taskType === 'terms-clauses-extract') {
        return JSON.stringify({
          clauses: [
            { kind: 'REQUIREMENT', text: 'Сверстать форму', category: 'x', isRequired: true, quote: 'сверстать форму' },
            { kind: 'REQUIREMENT', text: 'Придумано', category: 'x', isRequired: true, quote: 'в задании этого нет' },
          ],
        });
      }
      if (req.taskType === 'terms-match') {
        const ids = [...req.userPrompt.matchAll(/\[id=([^\]]+)\]/g)].map((m: any) => m[1]);
        return JSON.stringify({
          positions: [{ clauseId: ids[0], coverage: 'covered', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'форму сверстал на React' }],
        });
      }
      return '{}';
    });
    const extras = new HiringExtrasService(s.prisma as any, s.router as any, fakeAudit as any, s.sheets, s.matching);
    const project = s.prisma.seed('project', { ownerId: 'u', mode: 'JOB_SEARCH' });
    const sheet = s.prisma.seed('termsSheet', { projectId: project.id, kind: 'INTERVIEW', title: 'т' });

    const res = await extras.testAssignment('u', sheet.id, { assignmentText: 'Нужно сверстать форму заявки.', answerText: 'форму сверстал на React' });

    expect(res.requirements).toHaveLength(1);
    expect(res.draftSkips.assignment.withoutQuote).toBe(1);
    expect(res.draftSkips.answer).toEqual(emptySkips());
  });

  it('emptySkips / lostDrafts: ноль есть ноль, и дубль в сумму потерь не входит', () => {
    expect(lostDrafts(emptySkips())).toBe(0);
    expect(lostDrafts({ withoutQuote: 0, unknownClause: 0, malformed: 0, duplicateClause: 9, overLimit: 0 })).toBe(0);
    expect(lostDrafts({ withoutQuote: 1, unknownClause: 2, malformed: 3, duplicateClause: 99, overLimit: 4 })).toBe(10);
  });
});
