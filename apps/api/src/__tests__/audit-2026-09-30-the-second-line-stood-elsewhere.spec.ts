// Сверка 2026-09-30 — вторая линия стояла не у тех разборов.
//
// НАЙДЕНО. Продукт защищает границу «никаких вердиктов о людях» в две
// линии: абзац в промпте (`NO_PERSON_VERDICT_RULE`) и грубый фильтр
// выхода (`hasPersonVerdict`). Фильтр стоял в ТРЁХ местах — детектор
// манипуляций, живой детектор, паралингвистика, — и все три разбирают
// ПРИЁМ В РЕПЛИКЕ.
//
// А у разборов, чей предмет — САМ НАЗВАННЫЙ ЧЕЛОВЕК, стоял только
// промпт. Продукт при этом ведёт реестр, который называет эти разборы
// поимённо: `PERSON_RESEARCH_GATED` в `consent/person-research.ts` —
// портрет общения, прецеденты поведения, гипотезы о мотивах. То есть
// проект знал, где предмет опаснее всего, и вторую линию там не
// поставил. Шапка `no-person-verdict.ts` сама объясняет, почему вторая
// линия нужна («он ГРУБЫЙ… это вторая, на случай, когда первая не
// сработала»), и там же сказано, что сравнивались ДВА разбора — на
// этом сверка и остановилась.
//
// И ОТДЕЛЬНО, ХУЖЕ. Реестр освобождений от согласия PERSON_RESEARCH
// обосновывал освобождение детектора прощупывания так: «вывод о
// личности запрещён ОТДЕЛЬНЫМ ФИЛЬТРОМ». Фильтра не существовало:
// `isValidProbingPayload` проверял только непустоту строки. При этом в
// базу под именем человека ложится `ProbingTopic` с числовой
// уверенностью в том, что он «целенаправленно прощупывает». Право не
// спрашивать согласие держалось на ссылке на несуществующую проверку.
//
// ЧТО ПРОВЕРЯЕТСЯ. Поведение фильтра на каждом валидаторе (а не
// наличие импорта) и замкнутость: у каждого разбора из реестра
// `PERSON_RESEARCH_GATED` обе линии на месте.

import { readFileSync } from 'fs';
import { join } from 'path';
import { hasPersonVerdict, NO_PERSON_VERDICT_RULE } from '../common/no-person-verdict';
import { PERSON_RESEARCH_GATED, PERSON_RESEARCH_NOT_GATED } from '../consent/person-research';
import { isValidPrecedentPayload } from '../precedent-search/precedent-search.service';
import { isValidMotivePayload } from '../motive-analysis/motive-analysis.service';

const API_SRC = join(__dirname, '..');

function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Ответ модели нужной формы с подставленным описанием. ОДИН путь для
 * ключевых тестов и для пробы механизма: проба, идущая мимо той же
 * машинерии, проверяет соседнее выражение — Пункт
 * [probe-checked-the-neighbour]. */
function precedentPayload(description: string): string {
  return JSON.stringify([
    { precedentDescription: description, similarity: 'ANALOGOUS', sourceDescription: 'разговор 3' },
  ]);
}

describe('[the-second-line-stood-elsewhere] вторая линия стоит у разборов о человеке', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: валидатор прецедентов отклоняет вывод о личности', () => {
    // Форма верная, содержание — вердикт. До этого захода такой ответ
    // записывался в базу как прецедент поведения человека.
    expect(isValidPrecedentPayload(precedentPayload('он систематически лжёт о сроках'))).toBe(false);
    // И обратная половина: честный прецедент проходит — иначе фильтр
    // выключал бы сам разбор под видом его починки.
    expect(isValidPrecedentPayload(precedentPayload('дважды переносил срок на неделю'))).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: валидатор гипотез о мотивах отклоняет вывод о личности', () => {
    const verdict = JSON.stringify([
      { explanation: 'нарцисс, ему нужно признание', supportingFactsSummary: 'по трём разговорам', confidence: 'MEDIUM' },
    ]);
    expect(isValidMotivePayload(verdict)).toBe(false);
    const honest = JSON.stringify([
      { explanation: 'возможно, важнее признание, чем деньги', supportingFactsSummary: 'по трём разговорам', confidence: 'MEDIUM' },
    ]);
    expect(isValidMotivePayload(honest)).toBe(true);
  });

  it('проба механизма: фильтр действительно различает, а не отклоняет всё', () => {
    // Через ТОТ ЖЕ путь, что и ключевые тесты (`precedentPayload` +
    // валидатор), а не мимо него: иначе проба подтверждала бы работу
    // соседнего выражения.
    expect(isValidPrecedentPayload(precedentPayload('нарцисс по складу'))).toBe(false);
    // Назвать приём его именем — это работа детектора, а не вывод о
    // человеке. Шапка фильтра это оговаривает, и проба держит границу.
    expect(isValidPrecedentPayload(precedentPayload('в этой реплике подмена тезиса'))).toBe(true);
    expect(isValidPrecedentPayload(precedentPayload('давление сроком'))).toBe(true);
    // И сам фильтр отдельно — чтобы различение не зависело от формы
    // ответа именно этого разбора.
    expect(hasPersonVerdict('он лжёт')).toBe(true);
    expect(hasPersonVerdict('в этой реплике подмена тезиса')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого разбора из реестра PERSON_RESEARCH_GATED обе линии на месте', () => {
    // Правило по реестру, а не по списку файлов: реестр и есть то
    // место, где продукт называет «предмет — сам человек».
    const offenders: string[] = [];
    for (const entry of PERSON_RESEARCH_GATED) {
      const file = entry.site.split('#')[0];
      const src = code(file);
      if (!src.includes('hasPersonVerdict(')) offenders.push(`${file}: нет фильтра выхода`);
      if (!src.includes('NO_PERSON_VERDICT_RULE')) offenders.push(`${file}: нет абзаца в промпте`);
    }
    expect(offenders).toEqual([]);
    // Обратная проба: реестр не пуст, иначе пустой список выше не
    // значил бы ничего.
    expect(PERSON_RESEARCH_GATED.length).toBe(3);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: освобождение детектора прощупывания опирается на существующие проверки', () => {
    // Прежнее обоснование — «вывод о личности запрещён отдельным
    // фильтром» — ссылалось на то, чего не было. Проверяется не текст
    // обоснования, а ФАКТ наличия обеих линий там, куда оно указывает.
    const entry = PERSON_RESEARCH_NOT_GATED.find((e) => e.site.startsWith('probing-detector/'));
    expect(entry === undefined).toBe(false);
    const src = code(entry!.site.split('#')[0]);
    expect(src.includes('hasPersonVerdict(')).toBe(true);
    expect(src.includes('NO_PERSON_VERDICT_RULE')).toBe(true);
    // И абзац в промпте — один и тот же текст на все такие промпты:
    // разъехаться формулировками значило бы снова получить разные
    // границы у одной границы.
    expect(NO_PERSON_VERDICT_RULE.length).toBeGreaterThan(200);
  });
});
