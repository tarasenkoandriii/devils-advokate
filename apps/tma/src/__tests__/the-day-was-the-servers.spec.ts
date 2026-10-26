// Сверка [the-day-was-the-servers] 2026-10-26, клиентская половина.
//
// Серверные отказы по суточным потолкам стали называть, ЧЕРЕЗ СКОЛЬКО
// освободится место — раньше они говорили «попробуйте завтра» (неправда
// при скользящем окне) или «позже» (не ответ). Но самый точный текст
// ничего не стоит, если экран его выбрасывает. Нашлось два таких места.
//
// ПЕРВОЕ: кнопка озвучки. `const [error, setError] = useState(false)` —
// БУЛЕВО, и `catch { setError(true) }` выбрасывал текст целиком;
// человек видел «⚠️» на кнопке и ничего больше. Это та же болезнь, что
// уже разбиралась в комментарии в том же файле («кнопка молча
// показывала „⚠️", как будто недоступен ElevenLabs»): тогда вылечили
// ПРИЧИНУ — не было экрана согласия, — а механизм, который прячет любую
// причину, остался.
//
// ВТОРОЕ: главный экран узнавал причину отказа по СТАТУСУ. `403 →
// 'Согласие на использование AI отозвано'` затирал текст сервера, а три
// суточных потолка продукта отвечают именно 403. На этом экране такой
// отказ сегодня не достижим (проверено: его единственный 403 — отказ
// согласия), и поэтому здесь не «дефект», а ОТКРЫТАЯ ЛОВУШКА: признак
// «статус вместо кода» сообщает человеку о решении, которого он не
// принимал. Сервер присылает причину полем `code`, по нему и надо
// ветвиться.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: кнопка озвучки хранит ТЕКСТ отказа, а не «был ли отказ»', () => {
    const src = read('components/SpeakButton.tsx');
    assert(src.includes("useState<string | null>(null)"), 'состояние ошибки снова булево — текст отказа выброшен');
    assert(!/setError\(true\)/.test(src), '`setError(true)` вернулся: это и есть выбрасывание текста');
    assert(src.includes('speak-button-error'), 'текста отказа нет на экране — подсказки title на телефоне никто не увидит');
    assert(/role="alert"/.test(src), 'отказ не произносится скринридером: решение сверки 2026-09-04 обязано действовать и здесь');
  }],
  ['обратная проба: разбор смотрит на тот файл и видит его содержимое', () => {
    const src = read('components/SpeakButton.tsx');
    assert(src.includes('synthesizeSpeech'), 'прочитан не тот файл');
    assert(src.length > 1000, `файл подозрительно короткий: ${src.length}`);
  }],
  ['КЛЮЧЕВОЙ ТЕСТ: ветка «согласие отозвано» включается КОДОМ, а не статусом 403', () => {
    const src = read('app/page.tsx');
    assert(src.includes("err.code === 'CONSENT_REQUIRED'"), 'причина снова выводится из статуса — экран утверждает то, чего не знает');
    assert(!/httpStatus === 403/.test(src), 'признак по статусу 403 вернулся');
    // И текст сервера по-прежнему печатается в общей ветке: иначе
    // незнакомый отказ опять стал бы пустотой.
    assert(src.includes('${generationError}'), 'текст сервера больше не печатается ни в одной ветке');
  }],
  ['обратная проба: ветка «согласие» на экране ЕСТЬ — иначе проверка выше ни о чём', () => {
    const src = read('app/page.tsx');
    assert(src.includes('Согласие на использование AI отозвано'), 'ветка согласия исчезла целиком');
    assert(src.includes("generationErrorKind === 'consent'"), 'вид ошибки «consent» больше не используется');
  }],
  ['экран отметки брони не обещает календарный день', () => {
    // Сервер считает скользящие сутки; «дважды за день» читалось бы как
    // «после полуночи можно снова», а полночь тут ничего не значит.
    const src = read('app/venues/[id]/page.tsx');
    assert(!/Дважды за день/.test(src), '«за день» вернулось: клиент снова обещает календарный сброс');
    assert(/Дважды за сутки/.test(src), 'текст про повторную отметку исчез совсем');
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
console.log(`\nthe-day-was-the-servers (TMA): ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
