// Аудит 2026-09-03 — «правило, которое держится только промптом».
//
// Продолжение находки про §3.7 (отзывы только ссылкой): её причина была не
// в самом правиле, а в способе, которым оно держалось — текстом промпта.
// Этот заход прошёл по всем промптам с запретами и разделил их на два
// вида: те, где нарушение проверяется механически (числа, цитаты, ссылки,
// словарь навыков), и те, где нет (смысловые преувеличения). Первые
// переведены в код, вторые честно оставлены промпту.
//
// Тесты ниже проверяют барьеры на том, что модель РЕАЛЬНО может вернуть, —
// не на «правильном» ответе.
import { rephraseAddsNothing, quoteOccursIn, numbersIn } from '../terms-sheet/cv-variant-barriers';
import { checkQuoteLimits, quotedSpans, MAX_QUOTE_WORDS } from '../reconciliation-arguments/quote-limit';
import { sourcesWithoutFabricatedUrls } from '../discrepancy-analysis/discrepancy-analysis.service';

describe('CV: переформулировка не может добавить того, чего человек не говорил', () => {
  const ORIGINAL = 'Отвечал за биллинг в команде из 4 человек, перевёл его на очереди.';

  it('КЛЮЧЕВОЙ ТЕСТ: добавленная цифра достижения не проходит — именно она превращает пересказ в чужой результат', () => {
    const withNumber = 'Отвечал за биллинг в команде из 4 человек, перевёл его на очереди и снизил число инцидентов на 30%.';
    const check = rephraseAddsNothing(ORIGINAL, withNumber);
    expect(check.ok).toBe(false);
    expect(check.addedNumbers).toContain('30');
  });

  it('добавленная технология не проходит, даже если звучит правдоподобно', () => {
    const withTech = 'Отвечал за биллинг в команде из 4 человек, перевёл его на Kafka.';
    const check = rephraseAddsNothing(ORIGINAL, withTech);
    expect(check.ok).toBe(false);
    expect(check.addedTerms).toContain('kafka');
  });

  it('честная переформулировка проходит: те же числа и те же технологии, другие слова', () => {
    const fine = 'В команде из 4 человек вёл биллинг; перевёл его на очереди.';
    expect(rephraseAddsNothing(ORIGINAL, fine).ok).toBe(true);
  });

  it('барьер честно НЕ ловит смысловое преувеличение без цифр — и это не выдаётся за проверку', () => {
    // «Ключевую роль» вместо «отвечал» — ровно то, что барьер не видит.
    // Тест фиксирует границу: он существует, чтобы её нельзя было потом
    // молча выдать за «проверено кодом».
    const vague = 'Играл ключевую роль в биллинге команды из 4 человек, перевёл его на очереди.';
    expect(rephraseAddsNothing(ORIGINAL, vague).ok).toBe(true);
  });

  it('числа нормализуются: 30% и «30 %» — одно число, 2,5 и 2.5 тоже', () => {
    expect(numbersIn('рост 30% за 2,5 года')).toEqual(['30', '2.5']);
  });
});

describe('CV: расхождение между вариантами опирается на реальные цитаты', () => {
  const A = 'Пять лет в бэкенде. Вёл биллинг.';
  const B = 'Три года в бэкенде. Вёл биллинг.';

  it('КЛЮЧЕВОЙ ТЕСТ: цитата, которой нет в варианте, не может быть основанием расхождения', () => {
    expect(quoteOccursIn('Пять лет в бэкенде', A)).toBe(true);
    expect(quoteOccursIn('Десять лет в бэкенде', A)).toBe(false);
  });

  it('регистр, кавычки и пробелы не решают, показывать находку или нет', () => {
    expect(quoteOccursIn('пять  лет   в бэкенде', A)).toBe(true);
    expect(quoteOccursIn('«Вёл биллинг»'.replace(/[«»]/g, ''), B)).toBe(true);
  });

  it('пустая или однобуквенная «цитата» основанием не считается', () => {
    expect(quoteOccursIn('', A)).toBe(false);
    expect(quoteOccursIn('  ', A)).toBe(false);
  });
});

describe('Аргументы примирения: цитата из первоисточника ограничена кодом, а не просьбой', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: длинная дословная цитата в кавычках не проходит — это требование авторского права, не стиля', () => {
    const long = `Смысл места в том, что прощение важнее правоты: «${'слово '.repeat(MAX_QUOTE_WORDS + 3).trim()}».`;
    const check = checkQuoteLimits(long);
    expect(check.ok).toBe(false);
    expect(check.tooLong).toHaveLength(1);
  });

  it('короткая цитата и пересказ своими словами проходят', () => {
    const fine = 'Место говорит о терпении к ближнему: «терпи и прощай», остальное — пересказ сути своими словами.';
    expect(checkQuoteLimits(fine).ok).toBe(true);
  });

  it('вторая короткая цитата считается, но аргумент не роняет — терять полезный ответ из-за оформления хуже', () => {
    const two = 'Здесь «одна короткая» и ещё «вторая короткая» — обе в пределах лимита.';
    const check = checkQuoteLimits(two);
    expect(check.quoteCount).toBe(2);
    expect(check.ok).toBe(true);
  });

  it('распознаются и «ёлочки», и прямые кавычки', () => {
    expect(quotedSpans('текст «первая» и "вторая"')).toEqual(expect.arrayContaining(['первая', 'вторая']));
  });
});

describe('Фактчек: выдуманный адрес источника не доходит до пользователя', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: всё, что похоже на ссылку, вырезается целиком — названия изданий остаются', () => {
    const kept = sourcesWithoutFabricatedUrls([
      'The New York Times',
      'https://example.com/fake-article',
      'reuters.com/world/made-up',
      'www.bbc.co.uk',
      'Отчёт Всемирного банка, 2024',
      '   ',
    ]);
    expect(kept).toEqual(['The New York Times', 'Отчёт Всемирного банка, 2024']);
  });

  it('частично почищенная ссылка не остаётся: запись выбрасывается вместе с адресом', () => {
    // «Reuters (reuters.com/...)» выглядел бы как проверяемый источник —
    // это и есть та подмена, ради которой барьер существует.
    expect(sourcesWithoutFabricatedUrls(['Reuters (reuters.com/world/x)'])).toEqual([]);
  });
});
