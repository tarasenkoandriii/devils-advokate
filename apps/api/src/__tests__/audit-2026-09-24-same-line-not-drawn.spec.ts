// Сверка 2026-09-24 — граница проведена у одного разбора и не проведена
// у соседнего.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [audit-note-went-stale] показал, что
// заметка о проверке может пережить саму проверку. Здесь вопрос
// поставлен там, где цена ошибки у продукта наибольшая: у обещания «не
// детектор лжи, никаких оценок людей».
//
// ИЗМЕРЕНИЕ. Промптов в дереве 83; тридцать семь так или иначе говорят о
// человеке. Но применимость запрета «не суди о личности» определяется не
// словарём, а формой работы: разборов, которые получают реплику
// НАЗВАННОГО человека и возвращают о ней свободный текст, — два.
//
//  • ПАРАЛИНГВИСТИКА (§7.4): в промпте прямой запрет («ЗАПРЕЩЕНЫ суждения
//    о правдивости, намерениях, характере, психическом состоянии, любая
//    „детекция лжи"») И ВТОРАЯ ЛИНИЯ — стоп-слова в выходе модели, где
//    попадание означает провал валидации, то есть сигнал не пишется
//    вовсе. На экране под находками — оговорка теми же словами.
//
//  • ДЕТЕКТОР МАНИПУЛЯЦИЙ (полный разбор и живой): ни запрета в промпте,
//    ни проверки выхода, ни оговорки на экране. Валидатор смотрел ФОРМУ
//    ответа — массив, поля нужных типов, — и ни слова о содержании.
//
// А содержание здесь ПРЯМЕЕ, чем у паралингвистики: там описывают темп и
// паузы, тут называют приём в чужих словах, с числом уверенности, и
// `technique`/`description` приходят свободным текстом. Ответ вида
// «собеседник лжёт, типичный нарцисс» форму проходил и записывался.
//
// ПОЧЕМУ ЭТО НЕ РЯДОВОЕ «ПРАВИЛО НЕ ВЕЗДЕ». Запрет выводов о личности —
// не гигиена, а одно из оснований продукта. Из двух разборов, где он
// вообще применим, он стоял у одного.
//
// ЧЕГО ФИЛЬТР НЕ ДЕЛАЕТ. Он грубый — так и сказано там, откуда он взят.
// Список слов не ловит вывод о личности, выраженный иначе, и не
// притворяется, что ловит: первая линия — промпт, это вторая.
//
// И ЧЕГО В НЁМ НЕТ НАМЕРЕННО: слов «манипуляция», «давление», названий
// самих приёмов. Назвать приём — работа детектора, а не вывод о
// человеке; смешать одно с другим значило бы выключить разбор под видом
// его починки. Это проверяется ниже отдельно.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { hasPersonVerdict, NO_PERSON_VERDICT_RULE } from '../common/no-person-verdict';
import { parseParalinguisticsOutput, DEFAULT_PARALINGUISTICS_PROMPT } from '../conversations/paralinguistics.service';
import { isValidManipulationPayload, DEFAULT_SYSTEM_PROMPT as MANIPULATION_PROMPT } from '../manipulation-detector/manipulation-detector.service';
import { isValidFlagsPayload, SYSTEM_PROMPT as LIVE_MANIPULATION_PROMPT } from '../live-manipulation/live-manipulation.service';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Разборы, которые получают реплику названного человека и возвращают о
 * ней свободный текст. Список короткий и поимённый — потому что
 * признак «говорит о человеке» словарём не выводится, а ошибиться тут
 * дороже, чем где-либо ещё в продукте. */
const VERDICT_PRONE = [
  'conversations/paralinguistics.service.ts',
  'manipulation-detector/manipulation-detector.service.ts',
  'live-manipulation/live-manipulation.service.ts',
];

describe('Сверка [same-line-not-drawn]: запрет выводов о личности — одна граница на все разборы чужих слов', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: вывод о личности не проходит валидацию НИ У ОДНОГО из разборов', () => {
    // Поведение, а не наличие слова: прогоняются реальные валидаторы.
    const verdict = JSON.stringify([
      { segmentId: 's1', technique: 'переход на личности', description: 'собеседник лжёт, типичный нарцисс', confidence: 0.9 },
    ]);
    // Форма безупречна — раньше этого хватало, и именно это делало
    // проверку формы недостаточной.
    expect(JSON.parse(verdict)).toHaveLength(1);
    // Прогоняются НАСТОЯЩИЕ валидаторы обоих детекторов, а не только
    // общий предикат: первая редакция этого теста звала предикат и
    // утверждала в комментарии, что зовёт валидаторы. Проверка, которая
    // говорит о себе больше, чем делает, — ровно то, что эта сессия
    // ищет в продукте, и здесь она нашлась в собственном тесте.
    expect(isValidManipulationPayload(verdict)).toBe(false);
    expect(isValidFlagsPayload(JSON.stringify([{ technique: 'x', description: 'он врёт и манипулирует', confidence: 0.9 }]))).toBe(false);

    // Паралингвистика: её собственный разбор тоже отвергает.
    expect(parseParalinguisticsOutput(JSON.stringify({ segments: [{ segmentId: 's1', signals: [] }], note: 'он врёт' }))).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: честная находка проходит — фильтр не выключает сам разбор', () => {
    // Обратная проба, и здесь она важнее обычного: список стоп-слов,
    // захвативший названия приёмов, сломал бы детектор целиком, а тест
    // «вывод не проходит» этого бы не заметил.
    const honest = JSON.stringify([
      { segmentId: 's1', technique: 'подмена тезиса', description: 'вместо ответа о сроках переведена тема на прошлые ошибки', confidence: 0.6 },
      { segmentId: 's2', technique: 'давление на срочность', description: '«решай прямо сейчас, потом будет поздно»', confidence: 0.5 },
      { segmentId: 's3', technique: 'апелляция к эмоциям', description: 'вместо расчёта — «ты же понимаешь, как мне тяжело»', confidence: 0.4 },
    ]);
    expect(hasPersonVerdict(honest)).toBe(false);
    expect(isValidManipulationPayload(honest)).toBe(true);
    expect(isValidFlagsPayload(JSON.stringify([{ technique: 'ложная дилемма', description: '«или соглашайся, или мы расстаёмся» — третьего не предложено', confidence: 0.5 }]))).toBe(true);
    // И слово «манипуляция» само по себе — не вывод о личности.
    expect(hasPersonVerdict('в этой реплике использована манипуляция: ложная дилемма')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого такого разбора есть ОБЕ линии — запрет в промпте и проверка выхода', () => {
    // Первая линия проверяется на СОБРАННОМ ЗНАЧЕНИИ промпта, а не на
    // тексте файла. Первая редакция искала имя константы по исходнику —
    // и мутация «подставить пустую строку вместо запрета» прошла
    // насквозь: имя осталось в строке импорта. Тот же капкан, что уже
    // ловил эту сессию в [log-says-we-saw-it]; здесь он пойман мутацией,
    // а не случайностью.
    const prompts: Array<[string, string]> = [
      ['manipulation-detector', MANIPULATION_PROMPT],
      ['live-manipulation', LIVE_MANIPULATION_PROMPT],
      ['paralinguistics', DEFAULT_PARALINGUISTICS_PROMPT],
    ];
    for (const [name, prompt] of prompts) {
      expect([name, /ЗАПРЕЩЕН/.test(prompt)]).toEqual([name, true]);
      expect([name, /правдивости/.test(prompt)]).toEqual([name, true]);
      expect([name, /детекц|детектор/.test(prompt)]).toEqual([name, true]);
    }
    // Вторая линия: выход проверяется по содержанию, а не только по форме.
    for (const rel of VERDICT_PRONE) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect([rel, src.includes('hasPersonVerdict')]).toEqual([rel, true]);
    }
  });

  it('текст запрета один на все промпты — разъехаться формулировками нечем', () => {
    // Урок [label-is-the-choice]: как только текст скопируют, копии
    // начнут расходиться, и граница снова станет разной в разных местах.
    const copies = tsFiles(SRC).filter((f) => /ЗАПРЕЩЕНЫ суждения о правдивости/.test(readFileSync(f, 'utf8')));
    // Два: общий модуль и промпт паралингвистики (§7.4, свой текст с
    // ссылкой на пункт ТЗ — его дословность важна сама по себе).
    expect(copies.length).toBeLessThanOrEqual(2);
    expect(NO_PERSON_VERDICT_RULE).toMatch(/ЗАПРЕЩЕНЫ суждения о правдивости/);
  });
});
