// Сверка машинного текста 2026-09-04 — человеку показывали колонки базы.
//
// НАЙДЕННОЕ. `JsonView` — общий вьюер, которым нарисованы ЦЕЛЫЕ ВКЛАДКИ
// продукта: «Сверка консультаций» и «Проект соглашения» (у ДТП и у
// семейного права), «История цели», «Флаги соответствия», «Группа»,
// «Кандидаты команды», «Страховка», «Журнал доступа», «Уведомление о
// медиации», «Источники». Он печатал КЛЮЧИ ответа как заголовки, а часть
// эндпоинтов отдаёт сырые строки Prisma — то есть человек читал имена
// колонок базы: `goalDescription`, `occurredAt`, `action`.
//
// Пять способов, которыми машинный текст доходил до человека:
//   1. заголовки колонок и подписи полей — латиницей, именами полей;
//   2. перечисления сырьём: `DISCREPANCY_FOUND`, `not_covered`;
//   3. даты в ISO с миллисекундами и «Z»;
//   4. вложенный массив попадал в ячейку через `JSON.stringify` —
//      буквально фигурными скобками и кавычками;
//   5. готовый документ («Проект соглашения» — текст с дисклеймером и
//      переносами строк) раскладывался на поля, переносы схлопывались, и
//      предупреждение «это не юридически завершённый документ» тонуло.
//
// ФОРМА ЗНАКОМАЯ: «правило в проекте было, просто не везде». В TMA уже
// двадцать восемь карт подписей и готовые `dateTime()` / `money()` —
// общий вьюер не пользовался ни одной.
//
// ЧТО ИЗМЕНИЛОСЬ В САМОЙ ПРОВЕРКЕ, и это важнее правки. Все проверки
// интерфейса за эту сессию читали ИСХОДНИК регулярками — потому что
// раннер TMA компилировал JSX как `jsx: 'react'`, а компоненты написаны
// под автоматический рантайм Next.js и `React` в области видимости не
// держат: любая попытка НАРИСОВАТЬ компонент падала на
// `ReferenceError: React is not defined`. Существующие спеки компонентов
// не рисовали и потому этого не замечали. Одна строка в раннере — и
// проверять можно настоящую разметку. Здесь она и проверяется: не «в
// файле есть слово», а «на экране вот это».
//
// ЧЕСТНАЯ ГРАНИЦА, и она здесь главная: НЕИЗВЕСТНОЕ ПОЛЕ ПОКАЗЫВАЕТСЯ КАК
// ЕСТЬ. Придумать подпись полю, смысла которого никто не проверил, —
// соврать увереннее, чем показать `sourceSegmentId`. Словарь покрывает
// только прослеженное до эндпоинта или до модели Prisma, и тест ниже
// требует, чтобы каждое поле в словаре в проекте действительно
// существовало.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { JsonView } from '../components/domains/JsonPanel';
import { FIELD_LABEL, VALUE_LABEL, fieldLabel, valueLabel, formatMoment, looksLikeIsoMoment } from '../lib/field-labels';
import { COVERAGE_LABEL, STANCE_LABEL, SIDE_LABEL, STATUS_LABEL, EVIDENCE_LABEL } from '../lib/hiring/api';
import { CROSS_LABEL } from '../components/domains/dtp/dtp-types';

const SRC = join(__dirname, '..');
const API_SRC = join(__dirname, '../../../api/src');
const SCHEMA = join(__dirname, '../../../api/prisma/schema.prisma');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function html(data: unknown): string {
  return renderToStaticMarkup(createElement(JsonView, { data }));
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: заголовки — по-русски, а не именами колонок базы', () => {
    // «История цели» отдаёт сырые строки Prisma: `goalDescription`,
    // `changedAt`. Именно это человек и читал.
    const out = html([{ id: 'x1', configId: 'c1', goalDescription: 'Договориться об алиментах', changedAt: '2026-09-04T12:03:00.000Z' }]);
    assert(out.includes('формулировка цели'), `нет русской подписи поля: ${out}`);
    assert(!out.includes('goalDescription'), `имя колонки базы осталось на экране: ${out}`);
    assert(out.includes('изменено'), `нет подписи даты: ${out}`);
    assert(!out.includes('changedAt'), `имя колонки даты осталось: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: перечисления читаются словами, а не константами', () => {
    const out = html({ status: 'DISCREPANCY_FOUND', coverage: 'not_covered', side: 'EMPLOYER' });
    assert(out.includes('расхождение'), `состояние сверки сырое: ${out}`);
    assert(!out.includes('DISCREPANCY_FOUND'), `константа осталась на экране: ${out}`);
    assert(out.includes('не отражено'), `покрытие сырое: ${out}`);
    assert(out.includes('работодатель'), `сторона сырая: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: даты — как их читает человек, а не как их хранит база', () => {
    const out = html({ occurredAt: '2026-09-04T12:03:00.000Z' });
    assert(!out.includes('2026-09-04T12:03:00.000Z'), `ISO-дата осталась на экране: ${out}`);
    assert(/2026/.test(out), `дата исчезла совсем: ${out}`);
    // И обратная половина: строка, которая датой не является, датой не
    // становится. Догадка «похоже на дату» на чужих данных — способ
    // однажды показать человеку не то, что он ввёл.
    assert(formatMoment('2026-09-10') === '2026-09-10', 'дата без времени превращена в момент');
    assert(formatMoment('не дата') === 'не дата', 'произвольная строка превращена в дату');
    assert(!looksLikeIsoMoment('2026-09-10'), 'дата без времени принята за момент');
    assert(looksLikeIsoMoment('2026-09-04T12:03:00.000Z'), 'настоящий момент не распознан');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: вложенное рисуется, а не вываливается сырым JSON в ячейку', () => {
    // Раньше здесь стоял `JSON.stringify` — в ячейке таблицы человек
    // видел фигурные скобки и кавычки.
    const out = html([{ status: 'DISCREPANCY_FOUND', statements: [{ sourceLabel: 'Юрист А', whatWasSaid: 'сказал так' }] }]);
    assert(!out.includes('{&quot;') && !out.includes('{"'), `сырой JSON попал на экран: ${out}`);
    assert(out.includes('Юрист А') && out.includes('сказал так'), `вложенные данные потерялись: ${out}`);
    assert(out.includes('источник'), `у вложенной таблицы нет русских заголовков: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: готовый документ читается как документ, а не как дамп полей', () => {
    // «Проект соглашения» — экран, где дисклеймер «это не юридически
    // завершённый документ» обязан читаться. Раньше переносы строк
    // схлопывались, и он тонул посреди полей.
    const doc = 'Это черновик-компиляция фактов.\n\nУчастники: Я, Другая сторона\nБюджет: 1000 UAH';
    const out = html({ text: doc, generatedAt: '2026-09-04T12:03:00.000Z' });
    assert(out.includes('domain-longtext'), `многострочный текст показан как обычная строка: ${out}`);
    assert(out.includes('Участники'), `тело документа потерялось: ${out}`);
    assert(out.includes('документ'), `нет подписи поля текста: ${out}`);
    // Одиночная строка длинным текстом не становится — иначе в дампе
    // всё выглядело бы документом.
    assert(!html({ note: 'одна строка' }).includes('domain-longtext'), 'однострочное значение показано как документ');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: неизвестное поле показывается как есть, а не подписывается на глаз', () => {
    // Это и есть честная граница словаря. Проверка держит её с обеих
    // сторон: подписи выдумывать нельзя, но и прятать поле нельзя —
    // спрятанное поле человек не увидит вовсе.
    assert(fieldLabel('совершенноНовоеПоле') === 'совершенноНовоеПоле', 'неизвестное поле подписано выдумкой');
    assert(valueLabel('НЕИЗВЕСТНОЕ_СОСТОЯНИЕ') === 'НЕИЗВЕСТНОЕ_СОСТОЯНИЕ', 'неизвестное значение подписано выдумкой');
    const out = html({ совершенноНовоеПоле: 'значение' });
    assert(out.includes('совершенноНовоеПоле') && out.includes('значение'), `неизвестное поле исчезло с экрана: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: одно состояние не называется на двух экранах по-разному', () => {
    // Смысл словаря — собрать УЖЕ ПРИНЯТЫЕ проектом слова, а не сочинить
    // вторые. Регистр может отличаться (в карточке — с заглавной, в
    // ячейке таблицы — со строчной), слова — нет.
    const existing: Record<string, string> = {
      ...COVERAGE_LABEL,
      ...STANCE_LABEL,
      ...SIDE_LABEL,
      ...STATUS_LABEL,
      ...EVIDENCE_LABEL,
      ...Object.fromEntries(Object.entries(CROSS_LABEL).map(([k, v]) => [k, v.text])),
    };
    const divergent: string[] = [];
    for (const [key, mine] of Object.entries(VALUE_LABEL)) {
      const theirs = existing[key];
      if (theirs && theirs.toLowerCase() !== mine.toLowerCase()) divergent.push(`${key}: «${mine}» против «${theirs}»`);
    }
    assert(divergent.length === 0, `одно и то же состояние названо по-разному:\n  ${divergent.join('\n  ')}`);
    // И проверка самой проверки: если карты подписей вдруг перестанут
    // импортироваться, сравнивать будет не с чем, а тест останется
    // зелёным. Пересечение обязано быть непустым.
    const overlap = Object.keys(VALUE_LABEL).filter((k) => k in existing);
    assert(overlap.length >= 10, `сравнивать почти не с чем (${overlap.length}) — карты подписей отвалились?`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись заведена только для поля, которое в проекте существует', () => {
    // Защита ровно от того, чего словарю нельзя: подписи полю, которого
    // нет. Ищется имя поля в исходниках API (как ключ объекта) или в
    // схеме базы (как колонка).
    // Ищется и в API, и в самом TMA: часть полей ответа собирает экран
    // (`unreadable` из разбора строк письма) — поймано этой же проверкой
    // на первом же прогоне после пункта [own-input]. Файл словаря
    // исключён НАМЕРЕННО: иначе подпись подтверждала бы сама себя, и
    // проверка стала бы тавтологией.
    const apiText = [
      ...tsFiles(API_SRC),
      ...tsFiles(SRC).filter((f) => !f.endsWith('field-labels.ts')),
    ]
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const schema = readFileSync(SCHEMA, 'utf8');
    const ghosts: string[] = [];
    for (const key of Object.keys(FIELD_LABEL)) {
      const asObjectKey = new RegExp(`\\b${key}\\s*[:?]`).test(apiText);
      // Сокращённая запись свойства (`return { lineItems, byCurrency }`)
      // двоеточия не имеет — первый же прогон объявил призраком поле,
      // которое существует. Ошибка была в проверке, а не в словаре.
      const asShorthand = new RegExp(`[{,]\\s*${key}\\s*[,}\\n]`).test(apiText);
      const asPrismaField = new RegExp(`^\\s*${key}\\s+\\w`, 'm').test(schema);
      if (!asObjectKey && !asShorthand && !asPrismaField) ghosts.push(key);
    }
    assert(ghosts.length === 0, `подписи заведены для полей, которых в проекте нет:\n  ${ghosts.join('\n  ')}`);
  }],

  ['ИЗМЕРЕНИЕ: сколько мест рисуют ответ общим вьюером', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта. Рост —
    // повод проверить, не появилась ли ещё одна вкладка, целиком
    // нарисованная машинными полями.
    let uses = 0;
    for (const file of readdirSync(join(SRC, 'components/domains'), { recursive: true } as never) as string[]) {
      if (typeof file !== 'string' || !file.endsWith('.tsx')) continue;
      uses += (readFileSync(join(SRC, 'components/domains', file), 'utf8').match(/<JsonView\b/g) ?? []).length;
    }
    assert(uses >= 20, `мест с общим вьюером всего ${uses} — разбор сломан?`);
    assert(uses < 60, `мест с общим вьюером стало ${uses} — стоит проверить, все ли из них человеку понятны`);
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
console.log(`\nmachine-text: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
