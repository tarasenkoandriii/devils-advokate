// Сверка 2026-09-24 — отказ сообщался одной вибрацией.
//
// НАЙДЕННОЕ. В тридцати местах экранов единственным следом неудачи было
// `haptic('error')`. Человек нажимает кнопку, чувствует короткий толчок
// и не узнаёт НИЧЕГО: ни что не получилось, ни почему.
//
// Хуже молчания в трёх отношениях. Сервер пишет отказы человеческими
// словами («вы уже отмечались сегодня», «превышен суточный лимит»,
// «нужны оба согласия») — все они превращались в один и тот же толчок.
// Вибрация неразличима: успех и отказ отличаются рисунком, которого
// человек не помнит, а на части устройств вибрация выключена вовсе.
// И хуже всего на экранах СОГЛАСИЙ: человек нажал «согласен», запрос
// упал, он ушёл, не зная, записано согласие или нет.
//
// УРОК БЫЛ НАЗВАН РАНЬШЕ. Пункт [false-success] и сверка
// [self-reported-money] записали дословно: «сбой сообщался ОДНОЙ
// вибрацией: человек нажал и не узнал ничего, в том числе отказа „вы
// уже отмечали сегодня"». Применён он был к ОДНОМУ обработчику.
//
// ПРАВИЛО ПО ФОРМЕ: в обработчике действия `catch`, у которого нет
// ничего, кроме вибрации, — нарушение. Проверяется во всех экранах
// сразу, потому что следующий такой обработчик заведётся не там, где
// его ждут.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
    return name.endsWith('.ts') || name.endsWith('.tsx') ? [full] : [];
  });
}

function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Тела всех catch-блоков файла. */
function catchBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const m of source.matchAll(/catch\s*(\(\s*\w*\s*\))?\s*\{/g)) {
    const open = source.indexOf('{', m.index!);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    bodies.push(source.slice(open + 1, end).replace(/\s+/g, ' ').trim());
  }
  return bodies;
}

/** Сообщает ли обработчик человеку хоть что-нибудь, кроме вибрации. */
// Пункт [voiceprint-promised-what-it-could-not-do] 2026-09-26: к списку
// добавлен `message:` — состояние экрана регистрации отпечатка теперь
// носит свой текст одним значением (`setView({ state: 'error', message:
// '…' })`), и прежний список такой обработчик считал молчащим. Правило
// не ослаблено: `message:` внутри catch — это именно текст человеку, а
// не факт «что-то случилось». Ослаблением было бы вписать сюда `setView`
// целиком: тогда за сообщение сошёл бы любой переход состояния.
const TELLS = /set\w*Error|setErr\(|alert\(|throw |toast|setNotLoaded|setNotFound|setGeo\w*|setTranscriptionOff|setArgumentTrackingFailed|reportFailure|message:\s*'/i;

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: ни один обработчик не отвечает на неудачу одной вибрацией', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const body of catchBodies(code(file))) {
        if (!/haptic\('error'\)/.test(body)) continue;
        if (TELLS.test(body)) continue;
        offenders.push(`${file.replace(SRC, '')}: catch { ${body.slice(0, 60)} }`);
      }
    }
    assert(
      offenders.length === 0,
      `неудача сообщается только вибрацией (${offenders.length}):\n  ${offenders.join('\n  ')}\n` +
        'Вибрация не несёт ни факта, ни причины, а сервер пишет отказы словами.',
    );
  }],

  ['ОБРАТНАЯ ПРОБА: разбор действительно находит обработчик с одной вибрацией', () => {
    const offending = catchBodies("try { x(); } catch { haptic('error'); }");
    assert(offending.length === 1, 'разбор перестал находить catch-блоки вовсе');
    assert(/haptic\('error'\)/.test(offending[0]) && !TELLS.test(offending[0]), 'разбор не узнаёт «только вибрация»');
    const fixed = catchBodies("try { x(); } catch (err) { reportFailure(err, 'Не удалось'); }");
    assert(TELLS.test(fixed[0]), 'разбор не узнаёт исправленный обработчик');
    // Пункт [voiceprint-promised-what-it-could-not-do] 2026-09-26:
    // переход состояния БЕЗ текста по-прежнему считается молчанием —
    // иначе добавление `message:` в список стало бы лазейкой.
    const silentTransition = catchBodies("try { x(); } catch { setView({ state: 'error' }); haptic('error'); }");
    assert(!TELLS.test(silentTransition[0]), 'переход состояния без текста сошёл за сообщение человеку');
  }],

  ['экраны согласий называют, что именно не записалось', () => {
    const prompts = [
      'components/VoiceBiometricConsentPrompt.tsx',
      'components/LocationConsentPrompt.tsx',
      'components/ThirdPartyAudioConsentPrompt.tsx',
      'components/VoiceProcessingConsentPrompt.tsx',
    ];
    for (const rel of prompts) {
      const src = code(join(SRC, rel));
      assert(
        /reportFailure\(err, 'Не удалось записать согласие/.test(src),
        `${rel}: отказ записи согласия не назван. Человек нажал «согласен» и не знает, ` +
          'записано ли оно, — а вся механика согласий держится на том, что состояние известно.',
      );
    }
  }],

  ['отзыв согласия из настроек тоже не молчит', () => {
    const src = code(join(SRC, 'app/settings/page.tsx'));
    assert(
      /reportFailure\(err, 'Не удалось отозвать согласие/.test(src),
      'settings: провал ОТЗЫВА согласия сообщался вибрацией — человек уходит уверенным, ' +
        'что отозвал, а согласие осталось.',
    );
  }],

  ['объявление о неудаче — одно на всё приложение и произносится вслух', () => {
    const announcer = code(join(SRC, 'components/FailureAnnouncer.tsx'));
    assert(/role="alert"/.test(announcer), 'объявление не помечено как alert — программа чтения его не произнесёт');
    assert(/aria-label="Закрыть/.test(announcer), 'у кнопки закрытия нет доступного имени');
    // Закрывается рукой: отказ, исчезнувший сам, — это снова «нажал и
    // не узнал», только с задержкой.
    assert(!/setTimeout/.test(announcer), 'объявление исчезает само по таймеру');
    const layout = code(join(SRC, 'app/layout.tsx'));
    assert(/<FailureAnnouncer \/>/.test(layout), 'объявление не смонтировано в общем каркасе');
  }],

  ['вибрация не считается сообщением — ни в коде, ни в измерении', () => {
    // Мутация «вернуть haptic в список сигналов» ничего не ломает, пока
    // обработчиков с одним толчком не осталось: измерение считает
    // множество, которое сейчас пусто. Урок от этого не перестаёт быть
    // уроком — поэтому он утверждается прямо, о самом правиле.
    const spec = code(join(SRC, '__tests__/silent-failure-conventions.spec.ts'));
    const signals = /const SIGNALS = \/([^\n]*)\/;/.exec(spec);
    assert(signals !== null, 'в соседней сверке не нашёлся список того, что считается сигналом человеку');
    assert(
      !/haptic/.test(signals![1]),
      'вибрация снова засчитана как сообщение человеку. Она не несёт ни факта, ни причины, ' +
        'а на части устройств выключена вовсе — измерение с ней описывает не то, что называет.',
    );
  }],

  ['причина не только извлекается, но и показывается', () => {
    // Первая редакция проверяла только извлечение причины в библиотеке.
    // Мутация «перестать её рисовать» проходила насквозь: причина есть,
    // человек её не видит.
    const announcer = code(join(SRC, 'components/FailureAnnouncer.tsx'));
    assert(/\{failure\.reason/.test(announcer), 'объявление не показывает причину отказа');
    assert(/\{failure\.action\}/.test(announcer), 'объявление не говорит, что именно не получилось');
  }],

  ['сообщение сервера доходит до человека, а не заменяется нашим', () => {
    const lib = code(join(SRC, 'lib/failure-report.ts'));
    assert(
      /error instanceof Error && error\.message/.test(lib),
      'причина из ошибки не берётся — отказ «вы уже отмечались сегодня» снова станет общим словом',
    );
    assert(/haptic\('error'\)/.test(lib), 'вибрация убрана: она уместна, просто не единственна');
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
console.log(`\none-buzz-was-the-whole-answer: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
