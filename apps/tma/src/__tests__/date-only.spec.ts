// Сверка дат без времени 2026-09-04 — день, который сдвигался.
//
// НАЙДЕННОЕ. Поля «к какому сроку» — это `<input type="date">`, он даёт
// строку `2026-09-10`. Дальше стояло `new Date('2026-09-10')`, а по
// спецификации JS строка ТОЛЬКО С ДАТОЙ разбирается как полночь UTC, а не
// как полночь местного времени. В базу уезжало `2026-09-10T00:00:00.000Z`.
//
// Восточнее Гринвича это почти незаметно. Западнее — заметно сразу: в
// Чикаго (UTC−5) это 19:00 ДЕВЯТОГО, и на экране появлялось «09.09.2026»
// вместо выбранного десятого. Проверено прогоном, не рассуждением, — и
// проверяется здесь, с настоящей сменой часового пояса, а не рассказом
// про неё.
//
// Вторая половина неприятнее первой: «просрочено» считается как
// `dueDate < сейчас`. При полуночи UTC обещание «до 10 сентября» у
// человека в Киеве становилось просроченным в 03:00 десятого — утром
// того самого дня, когда срок ещё не вышел. Продукт, который помогает
// держать слово, сам утверждал о человеке неправду.
//
// ТРИ МЕСТА С ОДНОЙ ОШИБКОЙ, и в разных слоях: срок обещания (клиент
// собирал момент сам), срок в доменных формах (общий `EntityForm`),
// дедлайн цели решения — там голая строка уходила на сервер, и полночь
// UTC делал уже ОН. Часовой пояс знает только браузер, значит и момент
// собирать в браузере; сервер получает готовый ISO.
//
// ЧЕСТНАЯ ГРАНИЦА. В базе это по-прежнему момент времени, а не
// календарная дата: человек, поставивший срок в Киеве и открывший
// приложение в Нью-Йорке, на границе суток увидит другой день. Лечится
// колонкой `@db.Date`, то есть ручной миграцией — решение владельца.
// Здесь закрыт частый случай: один человек, один часовой пояс, и число
// на экране совпадает с тем, что он ввёл.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { endOfLocalDay, toDateInputValue } from '../lib/date-only';
import { coerceValues } from '../components/domains/EntityForm';
import { dueMoment } from '../lib/form-input';

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

/** Прогон в конкретном часовом поясе. Node перечитывает `process.env.TZ`
 * при каждом обращении к дате, так что переключение работает без
 * перезапуска процесса — проверено прямым замером. */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: западнее Гринвича выбранный день остаётся тем же днём', () => {
    // Именно здесь прежний код ломался: `new Date('2026-09-10')` в Чикаго
    // показывался как девятое.
    inTimeZone('America/Chicago', () => {
      const naive = new Date('2026-09-10').toLocaleDateString('ru-RU');
      assert(naive === '09.09.2026', `предпосылка теста неверна: наивный разбор дал ${naive}`);

      const fixed = new Date(endOfLocalDay('2026-09-10')).toLocaleDateString('ru-RU');
      assert(fixed === '10.09.2026', `человек выбрал 10-е, показано ${fixed}`);
    });
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: восточнее Гринвича день тоже не съезжает', () => {
    inTimeZone('Europe/Kyiv', () => {
      const fixed = new Date(endOfLocalDay('2026-09-10')).toLocaleDateString('ru-RU');
      assert(fixed === '10.09.2026', `человек выбрал 10-е, показано ${fixed}`);
    });
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «просрочено» наступает после конца дня, а не утром того же дня', () => {
    // «До 10 сентября» в обычной речи означает «включительно». Раньше в
    // Киеве срок истекал в 03:00 десятого — человек ещё мог всё сделать,
    // а приложение уже говорило «просрочено».
    inTimeZone('Europe/Kyiv', () => {
      const due = new Date(endOfLocalDay('2026-09-10')).getTime();
      const morningOfDueDay = new Date(2026, 8, 10, 9, 0, 0).getTime();
      const nextMorning = new Date(2026, 8, 11, 9, 0, 0).getTime();

      assert(due > morningOfDueDay, 'утром десятого срок уже считался истёкшим');
      assert(due < nextMorning, 'одиннадцатого срок обязан быть истёкшим');
    });
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: форма при открытии подставляет тот же день, который в ней записан', () => {
    // Раньше здесь стояло `.slice(0, 10)` / `.split('T')[0]` по ISO — то
    // есть дата в UTC. При хранении конца местного дня она отличается от
    // показанной, и форма подставляла бы не тот день.
    inTimeZone('America/Chicago', () => {
      const stored = endOfLocalDay('2026-09-10');
      assert(toDateInputValue(stored) === '2026-09-10', `в форму подставлено ${toDateInputValue(stored)}`);
      // Наивный способ на этих же данных даёт другой день — иначе
      // проверка ничего не доказывала бы.
      assert(stored.slice(0, 10) !== '2026-09-10', 'предпосылка теста неверна: UTC-дата совпала с местной');
    });
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран с полем «дата» не собирает момент времени сам', () => {
    // Проверка помощника доказывает, что он верен, но не что им
    // пользуются: мутация «вернуть наивный `new Date(dueDate)` на экран
    // обещаний» прошла мимо первых пяти проверок. Правило простое: где
    // есть поле выбора даты, там `new Date(...).toISOString()` не место —
    // это работа помощника, знающего про местную полночь.
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      if (!/type=["']date["']|type: 'date'/.test(src)) continue;
      for (const m of src.matchAll(/new Date\([^)]*\)\.toISOString\(\)/g)) {
        // Дата СО ВРЕМЕНЕМ собирается именно так и это верно — её ветка
        // помечена типом `datetime` рядом.
        const line = src.slice(src.lastIndexOf('\n', m.index ?? 0), (m.index ?? 0) + m[0].length);
        if (/datetime/.test(line)) continue;
        offenders.push(`${file.slice(file.indexOf('/src/') + 1)}: ${m[0]}`);
      }
    }
    assert(
      offenders.length === 0,
      `эти экраны собирают момент из даты сами, минуя местную полночь:\n  ${offenders.join('\n  ')}`,
    );

    // И вторая половина того же правила. Мутация «отправить голую строку
    // `2026-09-10` на сервер» первую проверку прошла: там нет
    // `new Date(...)`, полночь UTC делает уже сервер — тот же сдвиг дня
    // этажом ниже. Значит, экран с полем даты обязан не просто «не делать
    // неправильно», а ПОЛЬЗОВАТЬСЯ помощником.
    //
    // ГРАНИЦА ПРАВИЛА, найденная первым же прогоном: спрашивать дату и
    // ПРЕВРАЩАТЬ её в момент — разные роли. Экраны команды рекрутеров
    // только ОБЪЯВЛЯЮТ поле (`{ name: 'dueDate', type: 'date' }`), а
    // собирает payload общая форма `EntityForm`. Требовать помощника от
    // объявления бессмысленно — правило спрашивает с того, кто рисует
    // сам `<input type="date">`, потому что конвертирует именно он.
    const withoutHelper: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      if (!/<input[^>]*type=["']date["']/.test(src)) continue;
      // Пункт [own-input] 2026-09-04: сборка момента вынесена из
      // обработчиков в чистую `dueMoment()`, и теперь она ПРОВЕРЯЕТСЯ
      // вызовом (тест ниже), а не только упоминанием. Здесь остаётся то,
      // что вызовом проверить нельзя: экран, рисующий `<input type="date">`,
      // обязан пользоваться одним из двух сборщиков, а не собирать сам.
      if (!/dueMoment\(|endOfLocalDay\(/.test(src)) withoutHelper.push(file.slice(file.indexOf('/src/') + 1));
    }
    assert(
      withoutHelper.length === 0,
      `эти экраны спрашивают дату и не приводят её к концу местного дня:\n  ${withoutHelper.join('\n  ')}`,
    );
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: общая форма ОТПРАВЛЯЕТ конец местного дня, а не то, что ввели', () => {
    // Пункт [render-guards] 2026-09-04. Проверка ниже искала вызов
    // `endOfLocalDay(` в исходнике — и мутация «вызвать помощника, а
    // результат выбросить, отправив голую строку» проходила её
    // насквозь: вызов в файле есть, на сервер уезжает полночь UTC.
    // Сборка payload — чистая функция, значит её можно ВЫЗВАТЬ.
    inTimeZone('America/Chicago', () => {
      const out = coerceValues(
        [
          { name: 'dueDate', label: 'Срок', type: 'date' },
          { name: 'startsAt', label: 'Начало', type: 'datetime' },
        ],
        { dueDate: '2026-09-10', startsAt: '2026-09-10T14:30' },
      );
      const due = String(out.dueDate);
      assert(due !== '2026-09-10', 'на сервер уехала голая дата — полночь UTC делает уже он');
      assert(new Date(due).toLocaleDateString('ru-RU') === '10.09.2026', `человек выбрал 10-е, отправлено ${due}`);
      // Дата СО ВРЕМЕНЕМ по-прежнему собирается как местное время —
      // лечение не должно расползаться на соседнее.
      assert(new Date(String(out.startsAt)).getHours() === 14, 'время суток съехало у datetime');
    });
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: срок обещания и дедлайн цели тоже уходят концом местного дня', () => {
    // Долг, названный пунктом [render-guards]: эти два экрана собирали
    // payload прямо в обработчике, и мутация «вызвать помощника, а
    // результат выбросить» проходила проверку по исходнику насквозь.
    // Сборка вынесена в `dueMoment()` — её можно ВЫЗВАТЬ.
    inTimeZone('America/Chicago', () => {
      const sent = dueMoment('2026-09-10');
      assert(sent !== '2026-09-10', 'на сервер уходит голая дата — полночь UTC делает уже он');
      assert(new Date(String(sent)).toLocaleDateString('ru-RU') === '10.09.2026', `человек выбрал 10-е, отправлено ${sent}`);
    });
    // «Срок не указан» и «срок такой-то» — разные утверждения.
    assert(dueMoment('') === undefined, 'пустое поле превратилось в срок');
    assert(dueMoment(null) === undefined, 'null превратился в срок');
    assert(dueMoment(undefined) === undefined, 'undefined превратился в срок');
    assert(dueMoment('   ') === undefined, 'пробелы превратились в срок');
  }],

  ['пустое и неразборчивое значение не превращается в дату', () => {
    // «Срок не указан» и «срок такой-то» — разные утверждения; выдумывать
    // второе из первого нельзя.
    assert(toDateInputValue(null) === '', 'null превратился в дату');
    assert(toDateInputValue(undefined) === '', 'undefined превратился в дату');
    assert(toDateInputValue('не дата') === '', 'мусор превратился в дату');
    assert(endOfLocalDay('') === '', 'пустая строка превратилась в момент времени');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: дата со временем разбирается по-прежнему — правка не задела то, что работало', () => {
    // `datetime-local` даёт `2026-09-10T14:30` и разбирается как МЕСТНОЕ
    // время — это верно и менять не нужно. Ошибка была только у дат без
    // времени, и важно, что лечение не расползлось на соседнее.
    inTimeZone('America/Chicago', () => {
      const local = new Date('2026-09-10T14:30');
      assert(local.getHours() === 14, `время суток съехало: ${local.getHours()}`);
      assert(local.toLocaleDateString('ru-RU') === '10.09.2026', 'день у даты со временем съехал');
    });
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
console.log(`\ndate-only: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
