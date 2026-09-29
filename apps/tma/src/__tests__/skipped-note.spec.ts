// Сверка отброшенного 2026-09-04, экранная половина — «не найдено» и
// «не смогли подтвердить» не должны выглядеть одинаково.
//
// Серверная половина ([dropped-quotes], API) научилась считать находки
// модели, отброшенные за то, что их цитаты нет в исходном тексте, и
// возвращать число полем `skippedWithoutQuote`. Само по себе это ничего
// не меняет: число, которое никуда не печатается, — та же тишина, только
// с переменной. Экранов, где тишина читается как вердикт, четыре, и
// каждый из них пишет под пустым списком утвердительно:
//   «Compliance-флагов нет.»           — о тексте вакансии и о брифе
//   «Расхождений … не найдено.»        — о компании
//   «Новых критериев … не нашлось.»    — о словах самого человека
//   «compliance-флагов: N»             — о дебрифе, и при нуле молчит совсем
//
// Здесь проверяется именно ЭТО: помощник формулирует по-русски верно, и
// все четыре экрана его ВЫЗЫВАЮТ. Урок [guard-audit] уже трижды за
// сессию стоил ошибки: «есть импорт» и «есть вызов» — разные утверждения,
// и мутация «убрать вызов, оставить импорт» проходит первую проверку.

import { createElement, ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { skippedWithoutQuoteNote, draftSkipsNote, draftSkipsNotes, notCheckedNote, paralinguisticsNotes } from '../lib/skipped-note';
import { SkippedNote, DraftSkipsNotes, NotCheckedNote, ParalinguisticsNotes } from '../components/SkippedNotes';

/** Настоящая разметка компонента — то, что увидит человек. Раньше это
 * было невозможно: раннер собирал JSX так, что рисование падало, и все
 * проверки интерфейса поневоле читали исходник словами. */
function render<P extends object>(Component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(Component, props));
}

const SRC = join(__dirname, '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Экраны, которые под пустым списком УТВЕРЖДАЮТ, что находок нет. */
const CLAIMS_NOTHING_FOUND = [
  'components/domains/hiring/BriefAndPostingPanels.tsx',
  'components/domains/hiring/JobSearchToolsPanel.tsx',
  'components/domains/hiring/EmployerDossierPanel.tsx',
  'components/domains/hiring/TeamSheetTools.tsx',
];

/** Экраны, которые показывают ЧИСЛО созданных черновиков ([draft-outcome]).
 * Число само по себе человек читает как «столько в тексте и было» — или,
 * в тестовом задании, как суждение о работе кандидата. */
const SHOWS_DRAFT_COUNT = [
  'components/domains/hiring/TeamSheetTools.tsx',
  'components/domains/hiring/BriefAndPostingPanels.tsx',
  'components/domains/hiring/TermsSheetView.tsx',
  'components/domains/hiring/CandidateSheetTools.tsx',
];

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: ноль не печатается — иначе строку перестанут читать', () => {
    // Подпись «отброшено: 0» под каждым списком приучает её не замечать,
    // и тогда она не сработает там, где она нужна.
    assert(skippedWithoutQuoteNote(0) === '', 'ноль напечатался');
    assert(skippedWithoutQuoteNote(undefined) === '', 'отсутствие поля напечаталось');
    assert(skippedWithoutQuoteNote(null) === '', 'null напечатался');
    assert(skippedWithoutQuoteNote(-3) === '', 'отрицательное напечаталось');
    assert(skippedWithoutQuoteNote('2' as unknown) === '', 'строка напечаталась как число');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись говорит и о потере, и о причине — иначе она пугает, а не сообщает', () => {
    // Два утверждения обязаны быть оба: «список неполон» (иначе человек
    // читает пустоту как вердикт) и «показывать неподтверждённое нельзя»
    // (иначе выглядит как поломка, а это осознанное правило продукта).
    const note = skippedWithoutQuoteNote(3);
    assert(note.includes('3'), `в подписи нет числа: ${note}`);
    assert(/неполон/.test(note), `подпись не говорит, что список неполон: ${note}`);
    assert(/цитат/.test(note), `подпись не называет причину: ${note}`);
    // И ни намёка на то, ЧТО именно потеряно: текст отброшенной находки
    // опирается на выдуманную цитату, показывать его нельзя.
    assert(!/«/.test(note), `в подписи появилась цитата: ${note}`);
  }],

  ['русские числительные: 1 находка, 3 находки, 5 находок, 11 находок, 21 находка', () => {
    // Наивное `n < 5` даёт «11 находки». Мелочь, из-за которой строку
    // перестают читать как написанную для человека.
    // `\w` — это [A-Za-z0-9_] и кириллицу не ловит; поймано первым же прогоном.
    const форма = (n: number) => {
      const note = skippedWithoutQuoteNote(n);
      // «находок» — беглая гласная: основа не «находк», а «находо». Без
      // этого разбор молча не находил родительный падеж множественного.
      const m = note.match(/находо?к[а-я]*/);
      assert(m !== null, `для ${n} подпись без слова «находка»: ${JSON.stringify(note)}`);
      return m![0];
    };
    assert(форма(1) === 'находка', `1: ${форма(1)}`);
    assert(форма(2) === 'находки', `2: ${форма(2)}`);
    assert(форма(4) === 'находки', `4: ${форма(4)}`);
    assert(форма(5) === 'находок', `5: ${форма(5)}`);
    assert(форма(11) === 'находок', `11: ${форма(11)}`);
    assert(форма(12) === 'находок', `12: ${форма(12)}`);
    assert(форма(14) === 'находок', `14: ${форма(14)}`);
    assert(форма(21) === 'находка', `21: ${форма(21)}`);
    assert(форма(22) === 'находки', `22: ${форма(22)}`);
    assert(форма(25) === 'находок', `25: ${форма(25)}`);
    // Согласование глагола идёт за числительным, а не отдельно.
    assert(/отброшена/.test(skippedWithoutQuoteNote(1)), 'единственное число: не «отброшена»');
    // 21 — «находка отброшена», единственное число: согласование идёт за
    // последней цифрой, а не за величиной. Первая редакция теста ждала
    // здесь «отброшено» и была неправа сама.
    assert(/отброшена/.test(skippedWithoutQuoteNote(21)), '21: не «отброшена»');
    assert(/отброшено/.test(skippedWithoutQuoteNote(22)), '22: не «отброшено»');
  }],

  // ── Пункт [render-guards] 2026-09-04 ──
  //
  // Три проверки ниже раньше читали ИСХОДНИК регуляркой: «есть вызов»,
  // «вызов внутри JSX», «у тега есть role». Все три подтверждали наличие
  // текста в файле, и мутация «обернуть весь блок в `{false && …}`»
  // проходила их насквозь: подпись в файле есть, на экране её нет
  // никогда. Разметка вынесена в `components/SkippedNotes`, и теперь
  // проверяется то, что человек видит, — настоящий отрисованный HTML.

  ['КЛЮЧЕВОЙ ТЕСТ: подпись действительно появляется на экране — и внутри живой области', () => {
    const out = render(SkippedNote, { skipped: 3 });
    assert(out.includes('Ещё 3'), `подписи на экране нет вовсе: ${out}`);
    assert(/role="status"/.test(out), `подпись не в живой области: ${out}`);
    // Текст ВНУТРИ элемента с ролью, а не рядом: пустая живая область
    // объявляет ровно ничего. Мутация «оставить role, вынести текст
    // наружу» прежнюю проверку проходила.
    const live = /<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/.exec(out);
    assert(live !== null, `живой области в разметке нет: ${out}`);
    assert(/Ещё 3/.test(live![1]), `текст оказался вне живой области: ${out}`);
    // `status`, а не `alert`: это уточнение к уже показанному
    // результату, перебивать им чтение нечего.
    assert(!/role="alert"/.test(out), `подпись перебивает чтение: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: когда терять нечего — на экране не появляется ничего', () => {
    assert(render(SkippedNote, { skipped: 0 }) === '', 'ноль нарисовал пустую строку состояния');
    assert(render(SkippedNote, { skipped: undefined }) === '', 'отсутствие поля нарисовало подпись');
    assert(render(DraftSkipsNotes, { skips: {} }) === '', 'пустые потери нарисовали подпись');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: каждая причина потери — своя строка, и каждая произносится', () => {
    const out = render(DraftSkipsNotes, { skips: { assignment: { withoutQuote: 1 }, answer: { malformed: 2 } } });
    const live = out.match(/<p[^>]*role="status"[^>]*>/g) ?? [];
    assert(live.length === 2, `потоков два, живых областей ${live.length}: ${out}`);
    assert(out.includes('В тексте задания') && out.includes('В ответе'), `потоки слились: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экраны, утверждающие «не найдено», рисуют подпись общим компонентом', () => {
    // Что именно проверяется здесь текстом, а что нет: РАЗМЕТКА подписи
    // проверена рисованием выше, здесь — только факт, что экран её
    // ставит. Ни один тест не может угадать за нас, какой экран должен
    // о чём говорить, — этот список ведётся руками и защищает от
    // «подпись тихо убрали с одного из шести экранов».
    const silent: string[] = [];
    for (const rel of CLAIMS_NOTHING_FOUND) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      if (!/<SkippedNote\b/.test(src)) silent.push(rel);
    }
    assert(silent.length === 0, `эти экраны утверждают «не найдено» и не говорят об отброшенном:\n  ${silent.join('\n  ')}`);
  }],

  // ── Пункт [draft-outcome] 2026-09-04 ──

  ['КЛЮЧЕВОЙ ТЕСТ: причины потерь названы порознь, а не сведены в одно число', () => {
    // Сводить их вместе — значит отнять у человека единственное
    // действие, которое от него зависит: разбить текст на части.
    const note = draftSkipsNote({ withoutQuote: 2, unknownClause: 1, malformed: 1, duplicateClause: 5, overLimit: 3 });
    assert(/без опоры на ваш текст/.test(note), `нет причины «без опоры»: ${note}`);
    assert(/пункт, которого в листе нет/.test(note), `нет причины «выдуманный пункт»: ${note}`);
    assert(/неразборчивым ответом модели/.test(note), `нет причины «не та форма»: ${note}`);
    assert(/предел 40/.test(note), `нет причины «потолок»: ${note}`);
    // И совет — только там, где человеку есть что сделать.
    assert(/Разбейте текст на части/.test(note), `нет совета при обрезке: ${note}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: дубль не считается потерей и в подпись не попадает', () => {
    // Приписать дубль к потерям — та же неправда, что и молчать о них,
    // только в другую сторону: позиция по этому пункту у человека есть.
    assert(draftSkipsNote({ duplicateClause: 7 }) === '', 'один дубль дал подпись о потере');
    const note = draftSkipsNote({ withoutQuote: 1, duplicateClause: 7 });
    assert(/Ещё 1 черновик не сохранён/.test(note), `дубль попал в сумму: ${note}`);
    assert(!/7/.test(note), `число дублей просочилось в подпись: ${note}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: совет про потолок появляется ТОЛЬКО при обрезке', () => {
    // Совет «разбейте текст», когда текст ни при чём, — это ложная
    // подсказка: человек пойдёт делать бесполезную работу.
    const note = draftSkipsNote({ withoutQuote: 3 });
    assert(note !== '', 'потеря без подписи');
    assert(!/Разбейте/.test(note), `совет дан там, где он ни при чём: ${note}`);
  }],

  ['подпись пуста, когда всё предложенное сохранено', () => {
    assert(draftSkipsNote({}) === '', 'пустые потери дали подпись');
    assert(draftSkipsNote(null) === '', 'null дал подпись');
    assert(draftSkipsNote({ withoutQuote: 0, unknownClause: 0, malformed: 0, duplicateClause: 0, overLimit: 0 }) === '', 'нули дали подпись');
    assert(draftSkipsNotes(undefined).length === 0, 'undefined дал строки');
    assert(draftSkipsNotes({}).length === 0, 'пустой объект дал строки');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: несколько потоков разбора не сливаются в один', () => {
    // «Требование не извлеклось из задания» оставляет неполным чеклист,
    // «позиция не извлеклась из ответа» оставляет пункт без вывода. Для
    // человека, читающего ответ кандидата, это разные пробелы.
    const notes = draftSkipsNotes({ assignment: { withoutQuote: 1 }, answer: { malformed: 2 } });
    assert(notes.length === 2, `потоки слились: ${JSON.stringify(notes)}`);
    assert(notes.some((n) => /В тексте задания/.test(n)), `нет подписи задания: ${JSON.stringify(notes)}`);
    assert(notes.some((n) => /В ответе/.test(n)), `нет подписи ответа: ${JSON.stringify(notes)}`);
    // Пустой поток строки не даёт — иначе появится «В ответе: » ни о чём.
    assert(draftSkipsNotes({ assignment: { withoutQuote: 1 }, answer: {} }).length === 1, 'пустой поток дал строку');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экраны с числом черновиков рисуют подпись общим компонентом', () => {
    // Разметка и озвучивание проверены рисованием выше — здесь только
    // список экранов, которые обязаны о потерях говорить.
    const silent: string[] = [];
    for (const rel of SHOWS_DRAFT_COUNT) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      if (!/<DraftSkipsNotes\b/.test(src)) silent.push(rel);
    }
    assert(silent.length === 0, `эти экраны показывают число черновиков и молчат о потерянном:\n  ${silent.join('\n  ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись нигде не вписана по месту в обход общего компонента', () => {
    // Смысл выноса — одна разметка на все экраны. Копия, вписанная
    // рядом, снова окажется непроверяемой: её никто не нарисует.
    const inline: string[] = [];
    for (const file of tsxFiles(SRC)) {
      if (file.endsWith('SkippedNotes.tsx')) continue;
      const src = readFileSync(file, 'utf8');
      if (/skippedWithoutQuoteNote\(|draftSkipsNotes\(/.test(src)) inline.push(file.slice(file.indexOf('/src/') + 1));
    }
    assert(inline.length === 0, `подпись собрана в обход общего компонента:\n  ${inline.join('\n  ')}`);
  }],

  // ── Пункт [not-checked-looks-clean] 2026-09-06 ──
  //
  // Все подписи выше — о том, что разбор ЧТО-ТО потерял. Эта — о том, что
  // разбора не было: механизм не настроен или провайдер не ответил. Тогда
  // ноль находок не значит ничего, а экран под ним пишет утвердительно.
  ['КЛЮЧЕВОЙ ТЕСТ: «проверка не выполнялась» произносится словами, а не подразумевается', () => {
    const text = notCheckedNote('provider-failed', 'дебриф');
    assert(text.includes('дебриф'), 'подпись не называет, что именно не проверено');
    assert(text.includes('НЕ значит'), 'подпись не снимает утверждение о чистоте');
    assert(/провайдер/.test(text), 'подпись не называет причину');
    const other = notCheckedNote('not-configured', 'дебриф');
    assert(other !== text, 'две разные причины дают одну и ту же фразу — человек не узнает, что делать');
    assert(/настро/.test(other), 'о ненастроенной проверке не сказано, что её можно настроить');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: проверка ПРОШЛА — подписи нет, иначе её перестанут читать', () => {
    assert(notCheckedNote(null, 'дебриф') === '', 'подпись появилась там, где проверка выполнена');
    assert(notCheckedNote(undefined, 'дебриф') === '', 'undefined принят за причину');
    assert(notCheckedNote('всё хорошо', 'дебриф') === '', 'незнакомое значение принято за причину');
    assert(render(NotCheckedNote, { reason: null, what: 'дебриф' }) === '', 'компонент нарисовал пустую подпись');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись о непроверенном громче остальных — это не уточнение, а отсутствие ответа', () => {
    const html = render(NotCheckedNote, { reason: 'provider-failed', what: 'дебриф' });
    assert(html.includes('дебриф'), 'текст не произносится на экране');
    // `alert`, а не `status`: остальные подписи уточняют показанный
    // результат, эта говорит, что результата нет.
    assert(/role="alert"/.test(html), 'подпись не в области, которую читают вслух немедленно');
    assert(/>[^<]*Внимание[^<]*не проверен/.test(html), 'текст лежит рядом с живой областью, а не внутри неё');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран дебрифа действительно вызывает подпись, а не только импортирует её', () => {
    const src = readFileSync(join(SRC, 'components/domains/hiring/TeamSheetTools.tsx'), 'utf8');
    assert(/<NotCheckedNote\s/.test(src), 'экран дебрифа не рисует подпись о непроверенном');
    assert(/complianceNotChecked/.test(src), 'экран не читает признак, который отдаёт сервер');
  }],

  // ── Найдено мутацией при сверке [not-checked-looks-clean] 2026-09-06 ──
  //
  // Проверка «экран дебрифа вызывает подпись» читала ИСХОДНИК и прошла
  // насквозь мутацию `{false && <NotCheckedNote …/>}`: вызов в файле
  // есть, на экране его нет никогда. Ровно об этом предупреждает шапка
  // `components/SkippedNotes.tsx` — и проверка, написанная на неделю
  // позже, наступила на то же самое.
  //
  // Правило ниже написано ПО ПОСЛЕДСТВИЮ и сразу на все подписи, а не
  // на одну: подпись под заведомо ложным условием — это отсутствие
  // подписи, как бы условие ни было записано. Обратная проба ниже
  // проверяет, что правило вообще умеет срабатывать: за эту сессию
  // трижды выяснялось, что не умеет.
  ['КЛЮЧЕВОЙ ТЕСТ: ни одна подпись не выключена заведомо ложным условием', () => {
    const NOTES = /<(SkippedNote|DraftSkipsNotes|IntakeNotes|NotCheckedNote|ParalinguisticsNotes)[\s/>]/;
    const DISABLED = /\{\s*(false|0|null|undefined)\s*&&([\s\S]{0,400}?)\}/g;
    // Найдено мутацией при сверке [job-died-quietly] 2026-09-06: правило
    // выше знало только ЗАВЕДОМО ложное условие, а спрятать подпись можно
    // и НАСТОЯЩИМ — тем самым, из-за которого её не было видно.
    // Паралингвистика и была таким случаем: блок «Подача» рисовался при
    // `signals.length > 0`, и подпись о ПРОВАЛЕ, помещённая внутрь, не
    // появлялась ровно тогда, когда она единственно и нужна.
    //
    // Правило общее и верное для всех подписей: подпись сообщает, что
    // результата нет или он неполон, — значит её нельзя обусловливать
    // НАЛИЧИЕМ результата. Измерение перед написанием: таких мест в
    // дереве ноль, то есть правило не ломает ничего существующего.
    const HIDDEN_BEHIND_RESULTS = /\{[^{}]{0,120}?\.length\s*(?:>\s*0|!==\s*0)[\s\S]{0,900}?\}/g;
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(DISABLED)) {
        if (NOTES.test(m[2])) offenders.push(`${file}: выключена условием ${m[0].slice(0, 60)}`);
      }
      for (const m of src.matchAll(HIDDEN_BEHIND_RESULTS)) {
        if (NOTES.test(m[0])) offenders.push(`${file}: спрятана за наличием результата ${m[0].slice(0, 60)}`);
      }
    }
    assert(offenders.length === 0, `подпись не дойдёт до человека: ${offenders.join('; ')}`);

    // ОБРАТНЫЕ ПРОБЫ: оба правила обязаны ронять вот это.
    const probe = '<div>{false && <NotCheckedNote reason={x} what="y" />}</div>';
    const caught = [...probe.matchAll(DISABLED)].some((m) => NOTES.test(m[2]));
    assert(caught, 'правило не срабатывает на заведомо ложном условии — оно ничего не сторожит');
    const probe2 = '<div>{signals.length > 0 && <ParalinguisticsNotes enabled={e} error={x} skipped={n} />}</div>';
    const caught2 = [...probe2.matchAll(HIDDEN_BEHIND_RESULTS)].some((m) => NOTES.test(m[0]));
    assert(caught2, 'правило не срабатывает на подписи, спрятанной за наличием результата');
  }],

  // ── Пункт [job-died-quietly] 2026-09-06 ──
  //
  // Блок «Подача (паралингвистика)» рисовался только при непустом
  // списке отметок: при провале фоновой задачи на экране не появлялось
  // НИЧЕГО, и человек, включивший галочку, читал пустоту как «ничего не
  // было».
  ['КЛЮЧЕВОЙ ТЕСТ: провал разбора подачи произносится, и именно там, где блока нет', () => {
    const notes = paralinguisticsNotes(true, 'budget_exceeded', 0);
    assert(notes.length === 1, `ожидалась одна подпись, получено ${notes.length}`);
    assert(notes[0].includes('budget_exceeded'), 'причина от провайдера не показана — пересказ был бы беднее');
    assert(notes[0].includes('НЕ значит'), 'подпись не снимает утверждение «ничего не было»');

    const html = render(ParalinguisticsNotes, { enabled: true, error: 'budget_exceeded', skipped: 0 });
    assert(/role="alert"/.test(html), 'провал не в области, которую читают немедленно');
    assert(html.includes('budget_exceeded'), 'текст не произносится на экране');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: галочка не стояла — подписи нет, иначе она шум на каждом разговоре', () => {
    assert(paralinguisticsNotes(false, 'budget_exceeded', 5).length === 0, 'подпись появилась у разговора без разбора подачи');
    assert(paralinguisticsNotes(undefined, null, 0).length === 0, 'подпись появилась там, где о разборе не просили');
    assert(render(ParalinguisticsNotes, { enabled: true, error: null, skipped: 0 }) === '', 'удачный полный проход что-то нарисовал');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: провал и неполнота — разные подписи, не сведённые в одну', () => {
    const both = paralinguisticsNotes(true, 'провайдер молчит', 3);
    assert(both.length === 2, `провал и неполнота должны говорить порознь, получено ${both.length}`);
    // Первая — о том, что разбора не было; вторая — что был, но неполон.
    assert(both[0].includes('не выполнился'), 'первая подпись не о провале');
    assert(both[1].includes('3 отметки'), `русское числительное неверно: ${both[1]}`);
    assert(paralinguisticsNotes(true, null, 1)[0].includes('1 отметка'), 'единственное число неверно');
    assert(paralinguisticsNotes(true, null, 11)[0].includes('11 отметок'), '11 — всегда «отметок»');
  }],

  ['ИЗМЕРЕНИЕ: экранов с утверждением «ничего не найдено» — сколько их всего', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта. Резкий
    // рост — повод проверить, не завёлся ли новый экран, который молча
    // выдаёт отброшенное за отсутствующее.
    let claims = 0;
    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      claims += (src.match(/(не найдено|не нашлось|флагов нет)/g) ?? []).length;
    }
    assert(claims >= 4, `утверждений «ничего не найдено» всего ${claims} — разбор сломан?`);
    assert(claims < 40, `утверждений «ничего не найдено» стало ${claims} — стоит пересмотреть, все ли они честны`);
  }],
];

const results: Array<{ name: string; error?: string }> = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nskipped-note: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
