// Сверка языка отказов 2026-09-04 — что человек читает, когда ему
// отказали.
//
// Прежние заходы разбирали молчание («пробел выглядит как полнота») и
// неверные утверждения. Этот — про громкие ответы: продукт русский, а
// значительная часть его сообщений об ошибках была написана для
// разработчика и при этом доходила до человека дословно.
//
// КАК ЭТО ВЫГЛЯДЕЛО. В TMA 123 места показывают `err.message` как есть.
// На стороне API из 776 сообщений исключений 299 не содержали ни одной
// кириллической буквы. То есть человек видел на экране, например,
// «SparringSession cmf3x9q0000… is already ended» или «DtpParticipant
// cmf… not found»: чужой язык плюс внутренний идентификатор, из которого
// ничего не следует и с которым нечего делать.
//
// ЧТО СДЕЛАНО, И ПОЧЕМУ ДВУМЯ РАЗНЫМИ СПОСОБАМИ.
//
// 1. Ответы на СОБСТВЕННОЕ ДЕЙСТВИЕ человека переписаны поимённо: все 51
//    сообщение `BadRequestException` без кириллицы и сообщения отказа
//    входа (в том числе «Account is blocked» — момент, в который человеку
//    важнее всего понять, что произошло; теперь там сказано и что решение
//    можно оспорить). Здесь общая фраза не годится: осмысленное «Спарринг
//    уже завершён» полезнее любого «данные не подошли».
//
// 2. Класс «не найдено» (231 сообщение) НЕ переписывался, и это решение,
//    а не усталость. По конвенции проекта эти сообщения намеренно
//    неинформативны: «один ответ на „нет“ и „не ваш“», чтобы не
//    подтверждать существование чужих объектов. Их правильное место — не
//    на экране, а не «на экране, но по-русски». Поэтому в клиенте
//    (apps/tma/src/lib/api.ts) появилось одно правило вместо 231 правки:
//    сообщение без кириллицы написано не для человека и подменяется
//    человеческой фразой по статусу; исходный текст остаётся в
//    `technicalMessage`.
//
// НАЙДЕНО ПОПУТНО И ОКАЗАЛОСЬ ХУЖЕ ЯЗЫКА. `ConsentService.requireConsent()`
// бросал `Consent required: ${consentType} (userId=${userId}, …)` — то
// есть показывал человеку ЕГО ЖЕ внутренний идентификатор. А TMA опознавала
// эту ситуацию по подстроке в тексте сообщения
// (`err.message.includes('PUBLIC_SHARING')`): текст сообщения был негласным
// контрактом между API и экраном, и перевод сообщения на русский молча
// сломал бы согласие на публикацию. Теперь у ситуации устойчивый
// `code: 'CONSENT_REQUIRED'` и `consentType` в деталях — тот же приём, что
// уже применён к COMPANY_REQUIRED.
//
// НЕ СДЕЛАНО НАМЕРЕННО:
//  • 231 сообщение «не найдено» осталось английским НА СТОРОНЕ API —
//    закрыто со стороны клиента. Перевод их по одному потребовал бы
//    словаря человеческих названий для полусотни моделей, и это отдельная
//    работа с отдельной ценностью, а не хвост этой;
//  • admin-панель показывает технические тексты как есть: её читает
//    оператор, и для него имя модели с идентификатором — не шум, а
//    диагноз. Меняли бы — сделали бы хуже;
//  • измерение ниже — НИЖНЯЯ оценка. Регулярное выражение видит
//    сообщение-литерал сразу после `(`; многострочные шаблоны (каким был
//    как раз `Consent required: …`) в него не попадают. Это сказано
//    здесь, а не выдано за полный охват.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

const CYRILLIC = /[А-Яа-яЁё]/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Сообщения-литералы исключений: класс, текст, файл. */
function exceptionMessages(kinds: string[]): Array<{ kind: string; message: string; file: string }> {
  const pattern = new RegExp(String.raw`new (${kinds.join('|')})Exception\((\`[^\`]*\`|'[^']*'|"[^"]*")`, 'g');
  const out: Array<{ kind: string; message: string; file: string }> = [];
  for (const file of tsFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(pattern)) {
      out.push({ kind: m[1], message: m[2].slice(1, -1), file: relative(SRC, file) });
    }
  }
  return out;
}

describe('Язык отказов: что человек читает, когда ему отказали', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ответ на действие человека — по-русски', () => {
    // 400 приходит в ответ на то, что человек сам сделал: он ждёт
    // объяснения, а не строки из чужого словаря.
    const english = exceptionMessages(['BadRequest'])
      .filter((e) => !CYRILLIC.test(e.message))
      .map((e) => `${e.file}: ${e.message}`);
    expect(english).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отказ во входе и блокировка аккаунта — по-русски', () => {
    // Момент блокировки — тот, в котором человеку важнее всего понять,
    // что произошло и что он может сделать. Здесь были четыре «Account
    // is blocked».
    const english = exceptionMessages(['Unauthorized'])
      .filter((e) => !CYRILLIC.test(e.message))
      // Секреты server-to-server: их «читает» pg_cron и провайдер, не
      // человек. Перевод сделал бы лог хуже, а человеку они не видны.
      .filter((e) => !/dispatch secret|webhook secret/i.test(e.message))
      .map((e) => `${e.file}: ${e.message}`);
    expect(english).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сообщение человеку не несёт внутренний идентификатор', () => {
    // cuid в тексте — это не подсказка, а внутренняя структура: человеку
    // с ней нечего делать, а поддержке она и так доступна из логов.
    //
    // ИСКЛЮЧЕНИЕ, названное явно: операторская песочница. Там
    // идентификатор в ответе полезен — оператор сам его туда и ввёл, и
    // «проект X не найден» отвечает ровно на его вопрос. Правило «не
    // показывать внутреннее» — про человека, который идентификаторов не
    // вводил и не видит.
    const withIds = exceptionMessages(['BadRequest', 'Forbidden', 'Unauthorized'])
      .filter((e) => CYRILLIC.test(e.message))
      .filter((e) => !e.file.startsWith('admin-sandbox/'))
      .filter((e) => /\$\{[^}]*(Id|id)\b[^}]*\}/.test(e.message))
      .map((e) => `${e.file}: ${e.message}`);
    expect(withIds).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: требование согласия опознаётся по коду, а не по тексту сообщения', () => {
    // Комментарии снимаются: объяснение находки цитирует прежний код
    // дословно. Та же ловушка, что уже дважды срабатывала в этих
    // сверках, — и потому здесь она учтена сразу.
    const consent = stripComments(readFileSync(join(SRC, 'consent/consent.service.ts'), 'utf8'));
    expect(consent).toContain("code: 'CONSENT_REQUIRED'");
    expect(consent).toContain('consentType,');
    // И самого текста-контракта больше нет: он и был причиной, по которой
    // перевод сообщения ломал бы экран.
    expect(consent).not.toContain('Consent required:');
    expect(consent).not.toContain('userId=${userId}');

    // Клиент опознаёт ситуацию по коду, а не по подстроке.
    const section = stripComments(
      readFileSync(join(SRC, '..', '..', 'tma', 'src', 'components', 'PublicDiscussionSection.tsx'), 'utf8'),
    );
    expect(section).toContain("err.code === 'CONSENT_REQUIRED'");
    expect(section).not.toContain("err.message.includes('PUBLIC_SHARING')");
  });

  it('КЛЮЧЕВОЙ ТЕСТ: в клиенте есть страховка на одном месте, а не 231 правка', () => {
    const api = readFileSync(join(SRC, '..', '..', 'tma', 'src', 'lib', 'api.ts'), 'utf8');
    expect(api).toContain('humanizeApiError');
    expect(api).toContain('technicalMessage');
    // Признак — именно кириллица: подмена по статусу затронула бы и те
    // сообщения, что написаны для человека.
    expect(api).toMatch(/CYRILLIC.*=.*\[А-Яа-яЁё\]/);
  });

  it('ИЗМЕРЕНИЕ (нижняя оценка): сколько сообщений исключений остаётся без кириллицы и каких', () => {
    // Числа живут здесь, чтобы следующая сверка начинала с факта.
    // «Нижняя оценка» — потому что многострочные шаблонные сообщения это
    // регулярное выражение не видит; ровно таким был `Consent required`,
    // и он не попадал в прежние подсчёты.
    const all = exceptionMessages([
      'BadRequest',
      'NotFound',
      'Forbidden',
      'Unauthorized',
      'Conflict',
      'Gone',
      'UnprocessableEntity',
      'TooManyRequests',
      'InternalServerError',
    ]);
    const english = all.filter((e) => !CYRILLIC.test(e.message));
    const byKind = new Map<string, number>();
    for (const e of english) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);

    expect(all.length).toBeGreaterThan(700);
    // Осталось по существу одно семейство — «не найдено», закрытое
    // страховкой в клиенте. Если английских станет заметно больше,
    // значит семейство перестало быть одним.
    expect(byKind.get('BadRequest') ?? 0).toBe(0);
    expect(english.length).toBeLessThan(250);
    expect(byKind.get('NotFound') ?? 0).toBeGreaterThan(200);
  });
});
