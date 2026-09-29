// Сверка отброшенного 2026-09-04 — модель нашла, код отбросил, человек
// прочитал «ничего не найдено».
//
// ОТКУДА ВЗЯЛСЯ ЗАХОД. Сверка [silent-skips] искала молчаливые пропуски по
// оператору `continue` и нашла четыре детектора, у которых потеря находки
// была невидима в логе. Она искала не тем инструментом: `.filter(...)`
// выбрасывает так же молча и в `continue` не попадает. Поиск по фильтрам
// дал восемь мест в шести сервисах, и все восемь устроены одинаково:
// модель вернула находку с цитатой, цитаты в исходном тексте не оказалось,
// находка исчезла.
//
// ПОЧЕМУ ЭТО ХУЖЕ ЛОГА. Здесь потеря невидима НЕ В ЛОГЕ, А НА ЭКРАНЕ, и
// экран под пустым списком говорит утвердительно:
//   «Compliance-флагов нет.»
//   «Расхождений между источниками и досье не найдено.»
//   «Новых критериев в ваших словах не нашлось.»
// То есть продукт УТВЕРЖДАЕТ чистоту, которую не проверял. Для текста
// вакансии это утверждение о законности объявления, для дебрифа — о том,
// что интервьюер не упомянул защищённый признак. Ровно та форма дефекта,
// которую проект называет «пробел не должен выглядеть как отсутствие
// находок», только пробел здесь свой собственный, а не конфигурационный.
//
// ЧТО ИМЕННО ИСПРАВЛЕНО. Фильтр остался — он и есть «только из ваших
// слов»: находка с выдуманной цитатой не находка, а утверждение о
// человеке, которое нечем подкрепить. Изменилась ТОЛЬКО видимость
// потери: `keepQuoted()` возвращает число отброшенного, число доходит до
// ответа API и печатается над списком.
//
// ЧЕГО НАМЕРЕННО НЕ СДЕЛАНО (и это не забывчивость):
//  1. Текст отброшенной находки не показывается нигде. Он опирается на
//     цитату, которой в источнике нет; показать его — значит показать
//     человеку неподтверждённое утверждение о нём. Число честнее.
//  2. `proposeClauses` / `proposePositions` (черновики пунктов и позиций)
//     оставлены как есть. Их экраны показывают ЧИСЛО созданного и ведут
//     к списку, который человек подтверждает руками, — это не утверждение
//     о чистоте. А сменить их возврат с массива на объект — это 17 мест
//     вызова в пяти сервисах и админ-песочнице; в одном заходе с шестью
//     правками поведения каждая из них проверялась бы хуже. Записано
//     первым пунктом следующей сверки.
//  3. `ClientBriefService.questions()` НЕ считается дефектом: там цитата
//     без опоры обнуляется, а сам вопрос остаётся. Вопрос без цитаты —
//     всё ещё вопрос, ничего не потеряно.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { keepQuoted } from '../common/kept-with-quote';
import { VacancyPostingService } from '../vacancy-posting/vacancy-posting.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Комментарии прочь: дважды за эту сессию проверка ловила собственный
 * текст в комментарии вместо кода. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const TEXT = `Sales-менеджер
Ищем менеджера по продажам в B2B.

Условия:
Формат работы: удалённо. Оплата 1000-1500 USD. Молодой коллектив.`;

function seedPosting(prisma: any) {
  const team = prisma.seed('recruitingTeam', { name: 't', teamType: 'AGENCY' });
  prisma.seed('recruitingTeamMember', { teamId: team.id, userId: 'u', role: 'OWNER' });
  const project = prisma.seed('project', { ownerId: 'u', mode: 'INTERVIEW_POOL', recruitingTeamId: team.id });
  prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales', salaryRange: '1000-1500 USD', workArrangement: 'REMOTE', officeLocation: null });
  return project;
}

describe('Отброшенное без опоры: «не найдено» и «не смогли подтвердить» — разные вещи', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: проверка текста вакансии сообщает число отброшенных флагов, а не молчит о них', async () => {
    // Модель возвращает ДВА флага: один с настоящей цитатой, один с
    // выдуманной. Второй сохранять нельзя — и он не сохраняется. Но до
    // этой правки человек под списком читал «Compliance-флагов нет»,
    // когда настоящих флагов не было вовсе, — то есть «объявление
    // чистое» вместо «одну находку мы не смогли подтвердить».
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter((req: any) => {
      if (req.taskType === 'vacancy-posting-draft') return JSON.stringify({ text: TEXT });
      if (req.taskType === 'vacancy-posting-check') {
        return JSON.stringify({
          flags: [
            { category: 'возраст (прокси)', quotedText: 'Молодой коллектив', normKey: 'UA_ADVERTISING_PROTECTED', alternativeText: 'Дружная команда' },
            { category: 'x', quotedText: 'этой строки в объявлении нет', normKey: 'PROXY', alternativeText: 'y' },
            { category: 'z', quotedText: 'и этой тоже', normKey: 'PROXY', alternativeText: 'w' },
          ],
        });
      }
      return JSON.stringify({ clauses: [] });
    });
    const matching = new TermsMatchingService(prisma as any, router as any);
    const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
    const postings = new VacancyPostingService(prisma as any, router as any, sheets);

    const project = seedPosting(prisma);
    const rev = await postings.draftFromSheet('u', project.id);
    const check = await postings.check('u', rev.id);

    // UA_LANGUAGE — детерминированный флаг «нет украинской версии», он
    // к ответу модели отношения не имеет; здесь смотрим только на то,
    // что пришло от неё.
    const fromModel = check.complianceFlags.filter((f: any) => f.normKey !== 'UA_LANGUAGE');
    expect(fromModel).toHaveLength(1);
    expect(check.skippedWithoutQuote).toBe(2);
    // И отброшенное действительно НЕ попало в базу — считать его мы
    // считаем, но показывать выдуманную цитату по-прежнему нельзя.
    expect(prisma.rows('complianceFlag').map((f: any) => f.quotedText)).toContain('Молодой коллектив');
    expect(prisma.rows('complianceFlag').map((f: any) => f.quotedText)).not.toContain('этой строки в объявлении нет');
    expect(prisma.rows('complianceFlag').map((f: any) => f.quotedText)).not.toContain('и этой тоже');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: когда терять было нечего, число — ноль, а не «что-то потеряли»', async () => {
    // Обратная половина того же утверждения. Проверка, которая ловит
    // только «стало больше нуля», прошла бы и с константой 1 в коде.
    const prisma = createHiringFakePrisma();
    const router = createFakeRouter((req: any) => {
      if (req.taskType === 'vacancy-posting-draft') return JSON.stringify({ text: TEXT });
      if (req.taskType === 'vacancy-posting-check') return JSON.stringify({ flags: [{ category: 'возраст (прокси)', quotedText: 'Молодой коллектив', normKey: 'PROXY', alternativeText: 'Дружная команда' }] });
      return JSON.stringify({ clauses: [] });
    });
    const matching = new TermsMatchingService(prisma as any, router as any);
    const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
    const postings = new VacancyPostingService(prisma as any, router as any, sheets);

    const project = seedPosting(prisma);
    const rev = await postings.draftFromSheet('u', project.id);
    const check = await postings.check('u', rev.id);
    expect(check.complianceFlags.filter((f: any) => f.normKey !== 'UA_LANGUAGE')).toHaveLength(1);
    expect(check.skippedWithoutQuote).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: compliance брифа отдаёт объект с числом, а не голый массив', async () => {
    // Два исправления в одном: раньше голый массив экран показывал сырым
    // JSON (ветка разбора ждёт `complianceFlags`), и числу отброшенного
    // просто негде было ехать.
    const prisma = createHiringFakePrisma();
    const brief = 'Ищем женщину до 35 без маленьких детей, знание CRM обязательно.';
    const router = createFakeRouter((req: any) => {
      if (req.taskType === 'client-brief-compliance') {
        return JSON.stringify({
          flags: [
            { category: 'пол/возраст/дети', quotedText: 'женщину до 35 без маленьких детей', alternativeText: 'готовность к командировкам' },
            { category: 'x', quotedText: 'в брифе такого нет', alternativeText: 'y' },
          ],
        });
      }
      return JSON.stringify({ clauses: [] });
    });
    const matching = new TermsMatchingService(prisma as any, router as any);
    const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
    const briefs = new ClientBriefService(prisma as any, router as any, sheets, matching);

    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const b = await briefs.ingest('u1', project.id, { rawText: brief });
    const res = await briefs.complianceScan('u1', b.id);

    expect(Array.isArray(res)).toBe(false);
    expect(res.complianceFlags).toHaveLength(1);
    expect(res.skippedWithoutQuote).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: расхождение с досье требует ДВУХ цитат, и промах в любой одной считается', async () => {
    const prisma = createHiringFakePrisma();
    const document = 'В договоре указан адрес: Львов, ул. Зелёная, 1.';
    const router = createFakeRouter((req: any) => {
      if (req.taskType === 'employer-dossier-discrepancies') {
        return JSON.stringify({
          discrepancies: [
            // обе цитаты настоящие
            { topic: 'адрес', factQuote: 'Адрес: Киев', documentQuote: 'Львов, ул. Зелёная, 1', note: 'разные города' },
            // цитата из досье выдумана (пояснение заполнено нарочно:
            // Пункт [finding-without-substance-2] — иначе расхождение
            // отбрасывалось бы за пустое пояснение, а не за выдуманную
            // цитату, и тест зеленел бы по не той причине)
            { topic: 'директор', factQuote: 'Директор: Сидоров', documentQuote: 'Львов, ул. Зелёная, 1', note: 'в досье другой директор' },
            // цитата из документа выдумана
            { topic: 'квед', factQuote: 'Адрес: Киев', documentQuote: 'КВЕД 99.99', note: 'в документе нет такого КВЕД' },
          ],
        });
      }
      return '{}';
    });
    const audit = { records: [] as any[], record: async (r: any) => { audit.records.push(r); return r; } };
    const dossiers = new EmployerDossierService(prisma as any, router as any, audit as any);

    const project = prisma.seed('project', { ownerId: 'u1', mode: 'INTERVIEW_POOL' });
    const dossier = prisma.seed('employerDossier', { projectId: project.id, ownerId: 'u1', legalName: 'ТОВ Ромашка', jurisdiction: 'UA', registryCode: '12345678' });
    prisma.seed('employerDossierFact', { dossierId: dossier.id, category: 'REGISTRY', quote: 'Адрес: Киев', sourceUrl: 'https://usr.minjust.gov.ua/x', fetchedAt: new Date() });
    const brief = prisma.seed('clientBrief', { projectId: project.id, rawText: document, origin: 'EXTERNAL' });

    const res = await dossiers.discrepancies('u1', dossier.id, { briefId: brief.id });
    expect(res.discrepancies.map((d: any) => d.topic)).toEqual(['адрес']);
    expect(res.skippedWithoutQuote).toBe(2);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: голым .filter() по цитате не отбрасывает НИ ОДИН файл — иначе число снова потеряется', () => {
    // Проверка формы, а не упоминания: падает ровно тогда, когда кто-то
    // вернёт `.filter((f) => quoteIsFromSource(...))` вместо
    // `keepQuoted(...)`, то есть на возврате самого дефекта.
    //
    // ИСТОРИЯ ЭТОГО СПИСКА. Когда сверка [dropped-quotes] закрывала шесть
    // мест, `terms-matching` был назван здесь поимённо как отложенное
    // исключение — со сроком «первый пункт следующей сверки». Сверка
    // [draft-outcome] его закрыла, и список стал пустым: срок, записанный
    // в тесте, оказался настоящим, а не формальностью. Пустой список
    // держится так же строго — новое исключение молча не заведётся.
    const KNOWN: string[] = [];
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (!/\.filter\(\s*\([^)]*\)\s*=>[^;]{0,200}quoteIsFromSource/.test(src)) continue;
      offenders.push(file.slice(file.indexOf('/src/') + 1));
    }
    expect(offenders.sort()).toEqual(KNOWN);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: число не просто считается, а доходит до ответа — во всех шести местах', () => {
    // Урок [guard-audit] в четвёртый раз: «keepQuoted есть в файле» —
    // не то же самое, что «число уехало наружу». Мутация «посчитать и
    // не вернуть» проходит первую проверку и падает на этой.
    const REACHES_CALLER = [
      'vacancy-posting/vacancy-posting.service.ts',
      'client-brief/client-brief.service.ts',
      'hiring-extras/hiring-extras.service.ts',
      'vacancy-intake/job-search-tools.service.ts',
      'employer-dossier/employer-dossier.service.ts',
    ];
    const mute: string[] = [];
    for (const rel of REACHES_CALLER) {
      const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      const counts = (src.match(/keepQuoted\(/g) ?? []).length;
      // Каждый вызов помощника обязан иметь свой путь наружу: имя поля в
      // возвращаемом объекте или в отчёте.
      const surfaced = (src.match(/skippedWithoutQuote(?!\s*[:=]\s*0\b)/g) ?? []).length;
      if (counts === 0 || surfaced < counts + 1) mute.push(`${rel}: keepQuoted×${counts}, упоминаний наружу ${surfaced}`);
    }
    expect(mute).toEqual([]);
  });

  it('keepQuoted: считает выброшенное, не переставляет оставшееся, и на пустом списке даёт ноль', () => {
    const r = keepQuoted([1, 2, 3, 4], (n) => n % 2 === 1);
    expect(r.kept).toEqual([1, 3]);
    expect(r.skippedWithoutQuote).toBe(2);
    expect(keepQuoted([], () => true)).toEqual({ kept: [], skippedWithoutQuote: 0 });
    expect(keepQuoted(['a'], () => true)).toEqual({ kept: ['a'], skippedWithoutQuote: 0 });
  });

  it('ИЗМЕРЕНИЕ: сколько мест сверяют цитату с источником — чтобы следующая сверка начинала с факта', () => {
    let total = 0;
    for (const file of tsFiles(SRC)) {
      total += (stripComments(readFileSync(file, 'utf8')).match(/quoteIsFromSource\(/g) ?? []).length;
    }
    // Рост числа — повод проверить, посчитано ли отброшенное в новом месте.
    expect(total).toBeGreaterThanOrEqual(8);
    expect(total).toBeLessThan(25);
  });
});
