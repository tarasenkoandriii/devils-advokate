// Сверка 2026-09-05, экранная половина — пусто, потому что не
// загрузилось.
//
// НАЙДЕННОЕ. Четыре раздела TMA грузили свой список в `try`, а в `catch`
// ставили пустой список и молчали. Дальше экран рисует пустое состояние
// — и человек читает его как ответ продукта о своих данных, хотя ответа
// не было вовсе:
//
//   AssistanceScreen      — блок «Аргументы» не появляется вообще:
//                           неотличимо от «аргументов вы не готовили»,
//                           и это ВО ВРЕМЯ разговора, где человек ждёт
//                           отметок «прозвучал»;
//   MaterialChatSection   — «прошлых сессий нет» → начинает новую;
//   VenueRecommendation   — «мест не подобрано» → подбирает поверх уже
//                           подобранных;
//   WeatherForecastSection— «прогноза нет» → запрашивает заново.
//
// ПОЧЕМУ ЭТОГО НЕ ПОЙМАЛА ПРОШЛАЯ СВЕРКА. Пункт [voice-attribution]
// 2026-09-05 закрыл на ЭТОМ ЖЕ экране два пустых обработчика и оставил
// правило `!/\.catch\(\(\) => \{\}\)/`. Оно знает одну форму записи.
// `catch { setTrackedArguments([]); }` — третий пустой обработчик с тем
// же последствием, написанный иначе, и он прошёл мимо. Правило было,
// просто оно узнавало сбой в лицо, а не по последствию. Правило ниже
// написано по последствию: любой `catch`, который ставит пустой список
// и ничего больше, — нарушение, как бы он ни был записан.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Комментарии прочь перед разбором КОДА: в этом файле формулировки
 * «было раньше» процитированы в шапке. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function screens(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx')) out.push(full);
    }
  })(SRC);
  return out;
}

/** Тела всех `catch` в файле — с учётом вложенных скобок. Регулярка по
 * одной строке здесь не годится: обработчик занимает несколько строк, и
 * проверка «на упоминание» ловила бы соседний код. */
function catchBodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/catch\s*(\([^)]*\))?\s*\{/g)) {
    let depth = 1;
    let j = m.index! + m[0].length;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    out.push(src.slice(m.index! + m[0].length, j - 1));
  }
  return out;
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: ни один экран не гасит сбой пустым списком молча', () => {
    // Правило по ПОСЛЕДСТВИЮ, а не по форме записи: обработчик, который
    // ставит пустое значение и не помечает сбой, — нарушение, как бы он
    // ни был написан. Урок пункта [voice-attribution]: правило,
    // знающее одну форму записи, пропускает ту же ошибку в другой.
    const offenders: string[] = [];
    for (const file of screens()) {
      for (const body of catchBodies(code(file))) {
        const setsEmpty = /set[A-Z]\w*\(\s*(\[\]|null)\s*\)/.test(body);
        if (!setsEmpty) continue;
        // «Сказал о сбое» — это ЗАПИСАННОЕ состояние отказа, а не любое
        // упоминание слова error: `setGenerationError(null)` в начале
        // обработчика ничего не сообщает. Поэтому имя состояния плюс
        // непустой аргумент.
        const saysSo = /set\w*(Error|Failed|NotLoaded)\w*\(\s*(?!null\s*\)|false\s*\))/i.test(body) || /\bthrow\b/.test(body);
        if (!saysSo) offenders.push(`${file.slice(SRC.length + 1)}: ${body.trim().slice(0, 60)}`);
      }
    }
    assert(offenders.length === 0, `сбой гасится пустым списком молча: ${offenders.join(' | ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись говорит, что пусто ИЗ-ЗА СБОЯ, а не «здесь ничего нет»', () => {
    const src = code(join(SRC, 'components/NotLoadedNotice.tsx'));
    assert(/из-за сбоя связи/.test(src), 'не сказано, что пусто из-за сбоя');
    assert(/не потому, что здесь ничего нет/.test(src), 'не отделено от честного «ничего нет»');
    // Человек в этот момент смотрит не на экран — на разговор, на карту.
    assert(/role="status"/.test(src), 'появление подписи не объявляется вслух');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: у аргументов в живом разговоре сказано и ПОСЛЕДСТВИЕ', () => {
    // Остальные три раздела теряют вид; этот теряет работу. Отметок
    // «прозвучал / не прозвучал» не будет, и человек, который на них
    // рассчитывает, обязан узнать об этом сразу.
    const src = code(join(SRC, 'components/AssistanceScreen.tsx'));
    assert(/setArgumentTrackingFailed\(true\)/.test(src), 'сбой трекинга аргументов снова молчит');
    assert(/argumentTrackingFailed &&/.test(src), 'состояние заведено, но на экран не выводится');
    assert(/прозвучал/.test(src), 'не сказано, чего именно не будет в этом разговоре');
    // Успешная загрузка обязана гасить пометку: иначе она однажды
    // зажжётся и останется навсегда — такое же враньё, только наоборот.
    assert(/setTrackedArguments\(initial\);\s*setArgumentTrackingFailed\(false\)/.test(src),
      'пометка о сбое не гаснет после удачной загрузки');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: все четыре раздела действительно показывают подпись', () => {
    // Не «импорт есть в файле»: пункт [decision-basis] и три следующих
    // ловили ровно это — имя выживало в строке импорта, а на экран
    // ничего не выводилось.
    for (const rel of ['components/AssistanceScreen.tsx', 'components/MaterialChatSection.tsx',
      'components/VenueRecommendationSection.tsx', 'components/WeatherForecastSection.tsx']) {
      const src = code(join(SRC, rel));
      const uses = [...src.matchAll(/<NotLoadedNotice\b/g)].length;
      assert(uses >= 1, `${rel}: подпись не выводится на экран`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: подпись о неразобранном разборе приходит с сервера, а не сочиняется экраном', () => {
    // «Пары условий (AI)»: решение о том, состоялся ли разбор,
    // принимает тот, кто его запускал. Экран, который вывел бы это сам
    // из пустого списка, снова угадывал бы причину.
    const src = code(join(SRC, 'components/domains/hiring/TermsSheetView.tsx'));
    assert(/result\.note/.test(src), 'подпись о причине пустоты не показывается');
    assert(/role="status"/.test(src), 'подпись не объявляется вслух');
    assert(!/pairs\.length === 0/.test(src), 'экран снова сам решает, почему список пуст');
  }],

  ['ИЗМЕРЕНИЕ: где вообще стоит подпись о незагруженном', () => {
    // Точка отсчёта для следующей сверки: пятый раздел с молчаливым
    // пустым списком должен уронить первый тест этого файла, а не
    // добавиться сюда незамеченным.
    //
    // ПОПРАВКА, Пункт [empty-looked-like-an-answer] 2026-09-24. Точное
    // равенство четырём было ошибкой в замысле: оно «замечает» и РОСТ
    // числа разделов с подписью, то есть падает от того, что работа
    // сделана. Пятый молчаливый список и правда обязан ронять первый
    // тест — но это его дело, а не этого измерения. Здесь остаётся
    // нижняя граница: подпись существует и применяется, а не лежит
    // мёртвым компонентом.
    //
    // Число было 4 из 47 мест, где сбой выглядел ответом. Стало 28.
    const users = screens().filter((f) => /<NotLoadedNotice\b/.test(code(f)));
    assert(users.length >= 28, `разделов с подписью должно быть не меньше 28, найдено ${users.length}: ` +
      users.map((f) => f.slice(SRC.length + 1)).join(', '));
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
console.log(`\nfailure-looks-empty: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
