// Сверка 2026-09-24 — удостоверение было напечатано на странице.
//
// НАЙДЕННОЕ (серверная половина разобрана в `TODO.md`). Право участника
// публичного обсуждения «забрать своё» проверялось по его
// `participantId`, а публичная страница печатала этот же идентификатор
// для КАЖДОГО участника. Открывший ссылку получал список чужих
// удостоверений.
//
// ЧТО ПРОВЕРЯЕТСЯ ЗДЕСЬ. Страница — второй участник этой ошибки: она
// сама вычисляла «это моё», сравнивая чужие `participantId` со своим.
// Пока экран так делает, серверу приходится эти идентификаторы
// отдавать. Теперь на вопрос «чьё это» отвечает сервер, а секрет живёт
// только в памяти вкладки его владельца — и НЕ в localStorage: пришедший
// по ссылке не заводил аккаунта, и оставлять его удостоверение на
// чужом устройстве после закрытия вкладки продукт не вправе.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PAGE = 'app/public/[token]/page.tsx';
const API = 'lib/public-api.ts';

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: страница не сравнивает чужие идентификаторы со своим', () => {
    const src = code(PAGE);
    assert(
      !/\.participantId\s*===\s*participantId/.test(src),
      `${PAGE}: «это моё» снова вычисляется сравнением идентификаторов. ` +
        'Пока экран так делает, серверу приходится отдавать чужие participantId — ' +
        'а они были удостоверением.',
    );
    assert(
      /\bs\.mine\b/.test(src) && /\bc\.mine\b/.test(src),
      `${PAGE}: страница не пользуется ответом сервера «чьё это». ` +
        'Вопрос принадлежности решается там, где известны обе стороны.',
    );
  }],

  ['ОБРАТНАЯ ПРОБА: разбор действительно ловит сравнение идентификаторов', () => {
    const offending = '{participantId && s.participantId === participantId && (';
    assert(
      /\.participantId\s*===\s*participantId/.test(offending),
      'Выражение перестало находить сравнение — тогда ключевой тест проходит ' +
        'не потому, что сравнения нет, а потому, что его не ищут.',
    );
    assert(
      !/\.participantId\s*===\s*participantId/.test('{withdrawToken && s.mine && ('),
      'Выражение находит лишнее: чтение готового ответа — не сравнение.',
    );
  }],

  ['удостоверение уходит только в запрос на удаление, а не в чтение списка', () => {
    const src = code(API);
    const getLine = src.split('\n').find((l) => l.includes('/public/${token}${suffix}')) ?? '';
    assert(
      !/withdrawToken/.test(getLine),
      `${API}: секрет попал в чтение публичной страницы. Он нужен ровно двум ` +
        'запросам — удалению комментария и отзыву заявки.',
    );
    assert(
      /withdrawPublicComment[\s\S]*?withdrawToken/.test(src) && /withdrawPublicSubmission[\s\S]*?withdrawToken/.test(src),
      `${API}: удаление больше не передаёт удостоверение — значит опознание ` +
        'снова опирается на что-то, что сервер отдал всем.',
    );
  }],

  ['секрет не переживает вкладку: аккаунта у пришедшего по ссылке нет', () => {
    const src = code(PAGE);
    assert(
      /useState<string \| null>\(null\);[\s\S]{0,400}withdrawToken/.test(src) || /const \[withdrawToken, setWithdrawToken\] = useState/.test(src),
      `${PAGE}: удостоверение хранится не в состоянии страницы.`,
    );
    assert(
      !/localStorage|sessionStorage/.test(src),
      `${PAGE}: удостоверение (или что-то ещё) кладётся в хранилище браузера. ` +
        'Человек пришёл по ссылке на пять минут, возможно с чужого устройства, — ' +
        'оставлять там его ключ продукт не вправе.',
    );
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
console.log(`\nbadge-was-the-key: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);
