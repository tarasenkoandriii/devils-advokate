// Сверка 2026-09-05 — прочитано не всё, а сказано как про всё.
//
// НАЙДЕННОЕ. Пункт [partial-basis] 2026-09-04 закрыл усечение на
// ВЫХОДЕ: разбор строился на пяти последних прецедентах из скольких
// угодно, а подавался как разбор на всех. Та же беда на ВХОДЕ прожила
// незамеченной ещё сутки, и она тяжелее:
//
//   const text = params.text.slice(0, MAX_SOURCE_TEXT_CHARS);  // 16 000
//   userPrompt: userPrompt.slice(0, 24_000)
//   data: { rawText: dto.rawText.slice(0, 20_000) }
//
// Человек вставляет оффер на сорок тысяч знаков. Сохраняется двадцать
// тысяч, разбирается шестнадцать. Ответ приходит обычный: «Черновиков
// позиций: 7 — подтвердите их в списке пунктов». Ни слова о том, что до
// второй половины документа разбор не дошёл, — а неприятные условия
// живут как раз в конце.
//
// ХУЖЕ ВСЕГО ТАМ, ГДЕ ПУСТО. `skipped-note.ts` писал об этом прямо ещё
// в прошлой сверке: «Под пустым списком экраны пишут утвердительно:
// „Compliance-флагов нет“, „Расхождений не найдено“». Проверка дебрифа
// на защищённые признаки читала 24 000 знаков из сорока тысяч — и
// человек получал «нарушений нет» о всём тексте.
//
// ДВА УСЕЧЕНИЯ РАЗНЫЕ. «Не разобрано» повторимо: разбейте текст и
// повторите. «Не сохранено» необратимо: хвост документа в базу не
// попал, и повторный разбор его не найдёт. Свести их в одну подпись
// значило бы предложить человеку бесполезное действие.

import { TermsMatchingService, MAX_SOURCE_TEXT_CHARS, TERMS_CLAUSES_EXTRACT_TASK_TYPE } from '../terms-sheet/terms-matching.service';
import { MAX_OFFER_CHARS } from '../terms-sheet/terms-sheet.service';
import { createHiringFakePrisma, createFakeRouter } from './fake-prisma';
import { takeSource, intakeNote, promptIntakeNote, isTruncatedIntake, AI_PROMPT_CHARS } from '../common/source-intake';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..');

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(full);
    }
  })(API_SRC);
  return out;
}

describe('[input-truncated] сколько текста дошло до разбора — сказано', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: длинный текст режется, и об этом сказано НАРУЖУ', async () => {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter((req: any) => {
      if (req.taskType !== TERMS_CLAUSES_EXTRACT_TASK_TYPE) return '{}';
      return JSON.stringify({ clauses: [] });
    });
    const matching = new TermsMatchingService(prisma as any, router as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    const sheet = prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY_RESPONSE', vacancyId: null, title: 'x', status: 'DRAFT' });

    const long = 'я'.repeat(MAX_SOURCE_TEXT_CHARS + 5_000);
    const out: any = await matching.proposeClauses({
      userId: 'u1', projectId: project.id, sheetId: sheet.id,
      side: 'EMPLOYER' as any, text: long, evidenceKind: 'OFFER_TEXT' as any, evidenceRef: null, scenario: 'test',
    });
    expect(out.intake).toEqual({ used: MAX_SOURCE_TEXT_CHARS, total: long.length, limit: MAX_SOURCE_TEXT_CHARS });
    expect(isTruncatedIntake(out.intake)).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: МОДЕЛИ тоже сказано, что она видит часть', async () => {
    // Модель не может знать, что видит кусок, если ей об этом не
    // сказать: на обрезанном тексте вывод «такого условия в документе
    // нет» звучит так же уверенно, как на полном.
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => JSON.stringify({ clauses: [] }));
    const matching = new TermsMatchingService(prisma as any, router as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    const sheet = prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY_RESPONSE', vacancyId: null, title: 'x', status: 'DRAFT' });

    await matching.proposeClauses({
      userId: 'u1', projectId: project.id, sheetId: sheet.id,
      side: 'EMPLOYER' as any, text: 'я'.repeat(MAX_SOURCE_TEXT_CHARS + 1), evidenceKind: 'OFFER_TEXT' as any, evidenceRef: null, scenario: 'test',
    });
    const prompt = router.calls[0].userPrompt as string;
    expect(prompt).toMatch(/В разбор вошли первые/);
    expect(prompt).toMatch(/отсутствие условия здесь не значит/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: короткий текст НЕ помечается усечённым', async () => {
    // Сообщение об усечении там, где усечения не было, — такой же
    // обман, только в другую сторону. Мутация «всегда сообщать» обязана
    // падать здесь.
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => JSON.stringify({ clauses: [] }));
    const matching = new TermsMatchingService(prisma as any, router as any);
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    const sheet = prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY_RESPONSE', vacancyId: null, title: 'x', status: 'DRAFT' });

    const out: any = await matching.proposeClauses({
      userId: 'u1', projectId: project.id, sheetId: sheet.id,
      side: 'EMPLOYER' as any, text: 'короткий оффер', evidenceKind: 'OFFER_TEXT' as any, evidenceRef: null, scenario: 'test',
    });
    expect(isTruncatedIntake(out.intake)).toBe(false);
    expect(intakeNote(out.intake)).toBeNull();
    expect(promptIntakeNote(out.intake)).toBe('');
    expect(router.calls[0].userPrompt).not.toMatch(/В разбор вошли первые/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «не сохранено» и «не разобрано» — разные события', () => {
    // Первое необратимо, второе повторимо. Одна подпись на оба
    // предложила бы человеку бесполезное действие.
    const stored = takeSource('я'.repeat(30_000), MAX_OFFER_CHARS);
    const parsed = takeSource(stored.text, MAX_SOURCE_TEXT_CHARS);
    expect(stored.intake.used).toBe(MAX_OFFER_CHARS);
    expect(parsed.intake.used).toBe(MAX_SOURCE_TEXT_CHARS);
    // Разбор видит МЕНЬШЕ, чем сохранено: два потолка складываются, и
    // из тридцати тысяч знаков до модели доходит шестнадцать.
    expect(parsed.intake.used).toBeLessThan(stored.intake.used);
    const note = intakeNote(parsed.intake);
    expect(note).toMatch(/Разбейте текст на части/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: подпись человеку называет и сколько, и что делать', () => {
    const note = intakeNote({ used: 16_000, total: 40_000, limit: 16_000 })!;
    expect(note).toMatch(/16000/);
    expect(note).toMatch(/40000/);
    expect(note).toMatch(/40%/);
    // Главное — не число, а что оно означает: продукт не сказал о конце
    // документа НИЧЕГО, в том числе не сказал, что там пусто.
    expect(note).toMatch(/ни что там что-то есть, ни что там пусто/);
  });

  it('ИЗМЕРЕНИЕ: у каждого потолка есть имя, и он не спрятан в slice', () => {
    // Безымянный потолок нельзя ни назвать человеку, ни проверить
    // тестом — с этого изъян и начинался.
    expect(MAX_SOURCE_TEXT_CHARS).toBe(16_000);
    expect(AI_PROMPT_CHARS).toBe(24_000);
    expect(MAX_OFFER_CHARS).toBe(20_000);
  });

  it('ИЗМЕРЕНИЕ: текст источника не режется голым slice мимо словаря', () => {
    // Правило по дереву: новый `slice` по тексту, уходящему в модель,
    // должен уронить проверку. Смотрим на вызовы, где режут ИМЕННО
    // промпт или текст источника, а не цитату с потолком в 500 знаков.
    //
    // ПОПРАВКА 2026-09-30: в альтернативе были 20_000 и 24_000, но не
    // 16_000 — то есть голый `slice(0, 16_000)` это правило не видело,
    // хотя `MAX_SOURCE_TEXT_CHARS` равен ровно ему. Проверено мутацией:
    // мутация с числом проходила правило (её убивали поведенческие
    // тесты рядом), мутация с именем константы правило роняла. Дыра
    // была в одном выражении, а не в наборе, — и всё же дыра.
    // Пункт [the-empty-scan-was-green] 2026-10-02 — СНАЧАЛА доказываем,
    // что обход вообще что-то видит. Без этой строки правило зеленело бы
    // от переименованной папки: пустой обход даёт пустой список
    // нарушителей, и «нарушителей нет» означало бы «я ничего не читал».
    const scanned = sourceFiles();
    expect(scanned.length).toBeGreaterThan(400);
    const RULE = /(\w+)\.slice\(0,\s*(MAX_SOURCE_TEXT_CHARS|MAX_OFFER_CHARS|AI_PROMPT_CHARS|16_000|2[04]_000)\s*\)/g;
    const offenders: string[] = [];
    for (const file of scanned) {
      const src = code(file);
      for (const m of src.matchAll(RULE)) {
        offenders.push(`${file.slice(API_SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: то же правило ловит голый slice по имени константы и по числу', () => {
    // Иначе пустой список выше означал бы не порядок, а правило,
    // которое не срабатывает ни на чём. Регулярка берётся ТА ЖЕ —
    // объявлена в ключевом тесте выше и общая с ним.
    const RULE = /(\w+)\.slice\(0,\s*(MAX_SOURCE_TEXT_CHARS|MAX_OFFER_CHARS|AI_PROMPT_CHARS|16_000|2[04]_000)\s*\)/g;
    expect([...'text.slice(0, MAX_SOURCE_TEXT_CHARS)'.matchAll(RULE)]).toHaveLength(1);
    expect([...'text.slice(0, 16_000)'.matchAll(RULE)]).toHaveLength(1);
    // И не ловит потолок цитаты — ради этого исключения правило и
    // перечисляет имена, а не любой slice.
    expect([...'quote.slice(0, 500)'.matchAll(RULE)]).toHaveLength(0);
    expect(sourceFiles().length).toBeGreaterThan(400);
  });
});
