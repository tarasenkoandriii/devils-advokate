// Сверка 2026-09-05 — сбой, неотличимый от «ничего не найдено».
//
// НАЙДЕННОЕ. Весь продукт стоит на одном правиле: пробел не должен
// выглядеть как полнота. Четыре сверки подряд закрывали его на
// ОТБРОШЕННЫХ находках — сколько выпало и почему (`skippedByRules`,
// `skippedOwnDomain`, `skippedWithoutQuote`, `draftSkips`). Осталась
// вторая половина, о которой никто не спрашивал: сам ЗАПУСК разбора.
//
//  1. `proposeCounterparts` («Пары условий (AI)») отдавал пустой список
//     тремя разными путями — сравнивать было нечего; модель не
//     ответила; модель ответила, совпадений нет, — и наружу они шли
//     неразличимыми. В коде это называлось «честная деградация»:
//     деградация была честной, молчание о ней — нет.
//  2. Досье компании считает четыре вида потерь и называет их в отчёте.
//     Пятый — страница, отклонённая проверкой безопасности, — не
//     считался нигде, а над ним стоял комментарий «ноль здесь означает
//     именно ноль, а не „не считали“». Ровно наоборот: такую страницу
//     как раз не считали. Отчёт с четырьмя названными потерями и одной
//     неназванной читается как полный — соседние строки ручаются за ту,
//     которой нет.
//
// ЧЕГО СВЕРКА НЕ МЕНЯЕТ. Деградацию. Ронять лист условий из-за сбоя
// одной AI-подсказки по-прежнему нельзя — меняется не поведение, а то,
// выдаёт ли продукт своё молчание за ответ модели.

import { TermsMatchingService, TERMS_COUNTERPARTS_TASK_TYPE } from '../terms-sheet/terms-matching.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';
import { attemptNote, attempted } from '../common/attempt-outcome';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

jest.mock('../common/safe-url-fetch', () => ({
  ...jest.requireActual('../common/safe-url-fetch'),
  fetchUrlText: jest.fn(async () => ({ text: 'текст страницы источника', intake: { used: 24, total: 24, limit: 8000 } })),
}));

const API_SRC = join(__dirname, '..');

/** Комментарии прочь перед разбором КОДА: за эту сессию проверки
 * несколько раз ловили собственный объяснительный текст. */
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

function sheetWithSides(prisma: any, opts: { employer: boolean; candidate: boolean }) {
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const sheet = prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY_RESPONSE', vacancyId: null, title: 'Backend', status: 'DRAFT' });
  if (opts.employer) prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'CONDITION', text: 'Удалённо', isRequired: false, orderIndex: 0, confirmedAt: new Date() });
  if (opts.candidate) prisma.seed('termsClause', { sheetId: sheet.id, side: 'CANDIDATE', kind: 'CONDITION', text: 'Удалённая работа', isRequired: true, orderIndex: 1, confirmedAt: new Date() });
  return sheet;
}

describe('[failure-looks-empty] пустой ответ говорит, ПОЧЕМУ он пуст', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: три причины пустоты различимы снаружи, и подписи у них разные', async () => {
    // Это и есть весь пункт. Один и тот же пустой список приходил из
    // трёх мест, и человек читал под ним «система сравнила и ничего не
    // нашла» там, где система не сравнивала.
    const prisma = createHiringFakePrisma();
    let mode: 'ok' | 'fail' = 'ok';
    const router = createFakeRouter((req: any) => {
      if (req.taskType !== TERMS_COUNTERPARTS_TASK_TYPE) return '{}';
      if (mode === 'fail') throw new Error('провайдер недоступен');
      return JSON.stringify({ pairs: [] });
    });
    const matching = new TermsMatchingService(prisma as any, router as any);

    // (1) Сравнивать нечего — разбор не запускался.
    const oneSided = sheetWithSides(prisma, { employer: true, candidate: false });
    const notAttempted = await matching.proposeCounterparts({ userId: 'u1', projectId: 'p', sheetId: oneSided.id });
    expect(notAttempted.outcome).toBe('not-attempted');
    expect(notAttempted.note).toMatch(/не запускался/);
    // И сказано, чего именно не хватило: без этого человек не знает, что сделать.
    expect(notAttempted.note).toMatch(/соискателя/);
    expect(router.calls).toHaveLength(0); // модель действительно не звали

    // (2) Модель не ответила — разбор не состоялся.
    const both = sheetWithSides(prisma, { employer: true, candidate: true });
    mode = 'fail';
    const failed = await matching.proposeCounterparts({ userId: 'u1', projectId: 'p', sheetId: both.id });
    expect(failed.outcome).toBe('failed');
    expect(failed.note).toMatch(/не состоялся/);

    // (3) Модель ответила, совпадений нет — это НАХОДКА, и подписи нет.
    mode = 'ok';
    const ok = await matching.proposeCounterparts({ userId: 'u1', projectId: 'p', sheetId: both.id });
    expect(ok.outcome).toBe('ok');
    expect(ok.note).toBeNull();

    // Все три отдают одинаково пустой список — различие ТОЛЬКО в подписи.
    for (const r of [notAttempted, failed, ok]) expect(r.pairs).toEqual([]);
    expect(notAttempted.note).not.toBe(failed.note);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: подпись под находкой отсутствует, под её отсутствием — есть', () => {
    // «Разбор состоялся» под каждым списком — шум, который приучает не
    // читать подписи; тогда пропадёт и единственная нужная.
    expect(attemptNote('ok', 'Сравнение')).toBeNull();
    expect(attempted('ok')).toBe(true);
    // `not-attempted` — не «почти ok»: у вызывающего кода не должно быть
    // повода написать `outcome !== 'failed'` и потерять его.
    expect(attempted('not-attempted')).toBe(false);
    expect(attempted('failed')).toBe(false);
    for (const outcome of ['not-attempted', 'failed'] as const) {
      const note = attemptNote(outcome, 'Сравнение условий');
      expect(note).toBeTruthy();
      // Прямым текстом: пусто ≠ «нет совпадений».
      expect(note).toMatch(/Пусто здесь не значит/);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: страница, отклонённая проверкой, считается НЕ разобранной, а не «без фактов»', async () => {
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => {
      throw new AIRouterContentBlockedError('содержимое отклонено');
    });
    const svc = new EmployerDossierService(prisma as any, router as any, fakeAudit as any);
    const project = prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const dossier = prisma.seed('employerDossier', {
      projectId: project.id, legalName: 'ТОВ Ромашка', registryCode: null,
      domain: 'romashka.ua', jurisdiction: 'UA', confirmedAt: new Date(), lastRefreshedAt: null,
    });
    // Источник, добавленный человеком: ссылка без цитаты.
    prisma.seed('employerDossierFact', { dossierId: dossier.id, category: 'PRESS', quote: null, sourceUrl: 'https://press.example/1', fetchedAt: new Date() });

    const report: any = await svc.refresh('u2', dossier.id);
    expect(report.sources).toBe(1);
    expect(report.factsAdded).toBe(0);
    // Вот ради чего пункт: ноль фактов объяснён.
    expect(report.skippedContentBlocked).toBe(1);
    // И не подменён соседним видом потерь — они значат разное.
    expect(report.skippedByRules).toBe(0);
    expect(report.skippedWithoutQuote).toBe(0);
    expect(report.failed).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: разобранная страница НЕ помечается отклонённой', async () => {
    // Обратная сторона: счётчик, который растёт всегда, не сообщает
    // ничего. Мутация «contentBlocked: true всегда» обязана падать здесь.
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter(() => JSON.stringify({ facts: [{ category: 'PRESS', quote: 'текст страницы источника' }] }));
    const svc = new EmployerDossierService(prisma as any, router as any, fakeAudit as any);
    const project = prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const dossier = prisma.seed('employerDossier', {
      projectId: project.id, legalName: 'ТОВ Ромашка', registryCode: null,
      domain: 'romashka.ua', jurisdiction: 'UA', confirmedAt: new Date(), lastRefreshedAt: null,
    });
    prisma.seed('employerDossierFact', { dossierId: dossier.id, category: 'PRESS', quote: null, sourceUrl: 'https://press.example/1', fetchedAt: new Date() });

    const report: any = await svc.refresh('u2', dossier.id);
    expect(report.skippedContentBlocked).toBe(0);
    expect(report.factsAdded).toBe(1);
  });

  it('ИЗМЕРЕНИЕ: ни один сервис не отдаёт голый пустой список из catch', () => {
    // Правило меряется по дереву, а не по списку файлов: пятый такой
    // catch должен уронить проверку. `return null` из этого правила
    // исключён намеренно — null проверяется вызывающим кодом и там уже
    // разбирается (снимок пула, повестка), а пустой список утекает
    // прямо на экран как результат.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = code(file);
      for (const m of src.matchAll(/catch\s*\([^)]*\)\s*\{/g)) {
        let depth = 1;
        let j = m.index! + m[0].length;
        while (j < src.length && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        const body = src.slice(m.index! + m[0].length, j - 1);
        if (/return\s*\[\s*\]\s*;/.test(body)) offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: у отчёта досье пять названных видов потерь, и все пять доходят до экрана', () => {
    // Точка отсчёта. Шестой вид потерь, добавленный без подписи на
    // экране, должен уронить эту проверку — именно так пятый и прожил
    // три сверки незамеченным.
    const service = code(join(API_SRC, 'employer-dossier/employer-dossier.service.ts'));
    // `++` у трёх счётчиков и `+=` у четвёртого: он копит число внутри
    // одной страницы, остальные считают сами страницы.
    for (const c of ['skippedByRules', 'skippedOwnDomain', 'skippedContentBlocked']) expect(service).toContain(`${c}++`);
    expect(service).toContain('skippedWithoutQuote +=');
    // `failed` — пятый: он список, а не счётчик.
    expect(service).toMatch(/report\.failed\.push/);

    // Подписи живут в TMA — сервер отдаёт число, экран решает, как о нём
    // сказать (тот же уговор, что в kept-with-quote.ts).
    const labels = readFileSync(join(API_SRC, '../../tma/src/lib/field-labels.ts'), 'utf8');
    for (const c of ['skippedByRules', 'skippedOwnDomain', 'skippedContentBlocked', 'failed']) {
      expect(labels).toMatch(new RegExp(`\\b${c}:\\s*'`));
    }
  });
});
