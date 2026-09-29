// Сверка прав кандидата 2026-09-04, экранная половина.
//
// Кандидат — единственный участник, который продукт не выбирал: ссылку
// ему прислали, аккаунта у него нет, спросить некого. Текст согласия
// обещал ему «можете попросить отозвать согласие», а способа не было:
// отзыв существовал только у рекрутера, за авторизацией. Серверная
// половина открыла ему тот же механизм по его же токену; здесь
// проверяется, что это ВИДНО и что сказано честно — рисованием
// настоящей разметки (урок [render-guards]).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CandidateConsentControls } from '../components/CandidateConsentControls';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function html(props: { token: string; revokedAt: string | null }): string {
  return renderToStaticMarkup(createElement(CandidateConsentControls, props));
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: право видно на экране, и сказано, что аккаунт не нужен', () => {
    const out = html({ token: 't', revokedAt: null });
    assert(/Отозвать согласие/.test(out), `кнопки отзыва нет: ${out}`);
    assert(/аккаунт для этого не нужен/.test(out), `не сказано, что аккаунт не нужен: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: уже отозвано — сказано прямо, и сказано, чего отзыв НЕ отменяет', () => {
    // «Отозвано» без перечня последствий человек достраивает в свою
    // пользу и решает, что стёрлось всё.
    const out = html({ token: 't', revokedAt: '2026-09-04T10:00:00.000Z' });
    assert(/Согласие отозвано/.test(out), `состояние не показано: ${out}`);
    assert(/не стирает/.test(out), `не сказано, чего отзыв не делает: ${out}`);
    assert(/удаление/i.test(out), `не сказано, куда идти за полным удалением: ${out}`);
    // Кнопки отзыва в этом состоянии быть не должно — иначе человек
    // нажмёт второй раз и решит, что первый не сработал.
    assert(!/Отозвать согласие</.test(out), `кнопка осталась после отзыва: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: состояние отзыва произносится вслух', () => {
    const out = html({ token: 't', revokedAt: '2026-09-04T10:00:00.000Z' });
    const live = /<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/.exec(out);
    assert(live !== null, `нет живой области: ${out}`);
    assert(/отозвано/i.test(live![1]), `состояние не внутри живой области: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отзыв не делается одним нажатием — и необратимость названа', () => {
    // Обратной кнопки «вернуть согласие» у кандидата нет, и делать вид,
    // что есть, нельзя. Шаг подтверждения обязан это проговаривать.
    const src = readFileSync(join(SRC, 'components/CandidateConsentControls.tsx'), 'utf8');
    assert(/setConfirming\(true\)/.test(src), 'отзыв срабатывает без подтверждения');
    assert(/вернуть согласие через эту ссылку будет нельзя/.test(src), 'необратимость не названа');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран анкеты действительно ставит этот блок', () => {
    // Компонент, который никто не выводит, — то же молчание, только с
    // файлом. Список экранов ведётся руками: угадать за нас, где право
    // обязано быть, тест не может.
    const src = readFileSync(join(SRC, 'app/pre-questionnaire/[token]/page.tsx'), 'utf8');
    assert(/<CandidateConsentControls\b/.test(src), 'на анкете нет блока отзыва согласия');
    assert(/consentRevokedAt/.test(src), 'экран не читает состояние отзыва — покажет кнопку уже отозвавшему');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: приём чужого профиля называет основание, а не молчит', () => {
    // Соседняя ветка того же экрана (самошеринг соискателя) основание
    // называет; командная передача молчала — и молчала именно там, где
    // данные пересекают границу организации.
    const src = readFileSync(join(SRC, 'app/candidate-shares/[token]/page.tsx'), 'utf8');
    assert(/Основание — его согласие/.test(src), 'экран приёма не называет основания передачи');
    assert(/может отозвать/.test(src), 'не сказано, что человек может отозвать согласие');
    assert(/Оценок и рейтингов кандидата здесь нет/.test(src), 'не повторена рамка продукта про отсутствие оценок');
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
console.log(`\ncandidate-rights: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
