// Сверка 2026-09-05, экранная половина — что человеку говорят ДО того,
// как он напишет своё имя, и может ли он забрать написанное.
//
// Публичное обсуждение открывает кто угодно по ссылке — без аккаунта,
// часто из пересланного сообщения. У этого человека было меньше всего
// прав из всех участников продукта: поле «Ваше имя (необязательно)»
// стояло без единого слова о том, где имя появится, а забрать написанное
// было нельзя ничем.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PAGE = 'app/public/[token]/page.tsx';

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: сказано, ГДЕ появится имя — до того, как его вводят', () => {
    const src = code(PAGE);
    const joinBlock = src.slice(src.indexOf('public-discussion-page__join'), src.indexOf('Ваше имя'));
    assert(/подписываются ваши комментарии/.test(joinBlock), 'не сказано, что именем подписываются комментарии');
    assert(/каждый, кто откроет эту ссылку/.test(joinBlock), 'не сказано, кто это увидит');
    // И то, чего на экране не видно: заявки идут без имени, но автор
    // проекта видит отправителя. Умолчать об этом — оставить человека с
    // неверной картиной в обе стороны.
    assert(/автор проекта видит, кто их прислал/.test(joinBlock), 'не сказано, что автор видит отправителя заявки');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: анонимность названа как настоящая, а не как галочка', () => {
    const src = code(PAGE);
    assert(/имя\s*\n?\s*не сохраняется вовсе/.test(src.replace(/\s+/g, ' ')) || /не сохраняется вовсе/.test(src),
      'не сказано, что при анонимном участии имя не сохраняется');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: свой комментарий можно забрать, чужой — нет', () => {
    const src = code(PAGE);
    assert(/withdrawPublicComment\(/.test(src), 'нет способа удалить свой комментарий');
    // Кнопка только у своего.
    //
    // ПОПРАВКА, Пункт [badge-was-the-key] 2026-09-24: прежде здесь
    // утверждалось СРАВНЕНИЕ `c.participantId === participantId` — то
    // есть механизм, а не результат. Именно это сравнение и заставляло
    // сервер отдавать чужие `participantId`, которые были
    // удостоверениями. Теперь спрашивается результат: у элемента есть
    // ответ «чьё это», и кнопка привязана к нему.
    assert(/c\.mine\b/.test(src), 'кнопка удаления показывается не только автору комментария');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: свою нерассмотренную заявку можно забрать, принятую — нет', () => {
    // Серверная сверка разрушающих действий видит только то, что
    // маршрут вызывается ИЗ КЛИЕНТСКОЙ БИБЛИОТЕКИ, — обёртка в
    // `public-api.ts` её удовлетворяет даже без кнопки на экране.
    // Поэтому «до кнопки можно дотянуться» проверяется здесь: мутация
    // показала, что иначе исчезновение вызова со страницы проходит
    // незамеченным.
    const src = code(PAGE);
    assert(/withdrawPublicSubmission\(token, submissionId, withdrawToken\)/.test(src),
      'экран не зовёт отзыв заявки');
    assert(/s\.mine\b/.test(src), 'кнопка отзыва показывается не только автору заявки');
    // Принятую заявку отзывать нельзя: она уже стала аргументом проекта.
    // Кнопка на ней была бы обещанием, которое сервер не выполнит.
    assert(/s\.status === 'PENDING'/.test(src), 'кнопка отзыва показывается и на уже принятой заявке');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сбой удаления не выдаётся за успех', () => {
    // Урок [false-success]: на этой же странице уже находили «получилось»
    // вместо ошибки.
    const src = code(PAGE);
    for (const fn of ['handleWithdrawComment', 'handleWithdrawSubmission']) {
      const handler = src.slice(src.indexOf(`async function ${fn}`), src.indexOf('if (loading) return null;'));
      assert(/setError\(/.test(handler), `${fn}: сбой удаления не показывается человеку`);
      assert(/await getPublicDiscussion\(token/.test(handler), `${fn}: после удаления список не перечитывается`);
    }
  }],
  ['КЛЮЧЕВОЙ ТЕСТ [self-reported-money]: отметка о брони не молчит при сбое', () => {
    // Здесь стояло `catch { haptic('error') }` — сбой сообщался ОДНОЙ
    // вибрацией: человек нажал и не узнал ничего, в том числе отказа
    // «вы уже отмечали сегодня». Урок [false-success]: молчание после
    // действия читается как «получилось».
    // Проверять надо ТЕЛО catch, а не наличие имени в файле: `setBookingError(null)`
    // в начале обработчика остаётся и после того, как из catch всё убрали.
    // Четвёртый раз за сессию тот же способ обмануть проверку — имя живо,
    // поведения нет.
    const src = code('app/venues/[id]/page.tsx');
    const handler = src.slice(src.indexOf('async function handleConfirmBooking'), src.indexOf('if (loading) return null;'));
    const catchBody = handler.slice(handler.indexOf('} catch'), handler.indexOf('} finally'));
    assert(/setBookingError\(/.test(catchBody), 'сбой отметки брони снова молчит');
    assert(/role="alert"/.test(src), 'сообщение о сбое не объявляется вслух');
    // И человеку сказано, что делает его нажатие: заведение эту отметку
    // не видит и не подтверждает.
    assert(/заведение её не видит и не подтверждает/.test(src), 'не сказано, что это отметка для себя');
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
console.log(`\npublic-name: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
