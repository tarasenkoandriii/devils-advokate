// Пункт [the-provider-had-rules-nobody-wrote-down] 2026-10-01 — правило
// чужой стороны, про которое продукт молчал, и отказ чужой стороны,
// который продукт пересказывал, не привязывая к своим переменным.
//
// НАЙДЕНО НА ЖИВОМ ПРОДЕ, ДВУМЯ ЗАХОДАМИ В ОДИН ДЕНЬ.
//
// Заход первый. Владелец выставил `TELEGRAM_WEBHOOK_SECRET` значением
// `openssl rand -base64 32` — ровно так, как было написано в
// `.env.example` и в `VERCEL.md`, — и получил от Telegram
// `{"ok":false,"description":"Bad Request: secret token contains illegal
// characters"}`. У `secret_token` закрытый алфавит (`A-Z`, `a-z`, `0-9`,
// `_`, `-`, длина 1..256), а в base64 есть `+`, `/` и `=`. То есть
// СОБСТВЕННАЯ ДОКУМЕНТАЦИЯ ПРОЕКТА порождала нерабочее значение, и
// узнать об этом можно было только от провайдера — после выставления
// переменной, редеплоя и операторской команды.
//
// Заход второй, и он важнее. Прочитав «secret token contains illegal
// characters», владелец поправил формат ТОГО СЕКРЕТА, КОТОРЫЙ ДЕРЖАЛ В
// РУКАХ: значения заголовка `x-dispatch-secret`, то есть
// `SCHEDULER_DISPATCH_SECRET`. Прогнал его через `tr '+/' '-_' | tr -d
// '='`, получил значение допустимого алфавита, вызвал регистрацию заново
// — и получил ТУ ЖЕ СТРОКУ ОТКАЗА. Потому что Telegram говорил о другой
// переменной, и в отказе о ней не было ни слова.
//
// Вывод, который и закрывается этой спекой: в одном вызове участвуют ДВА
// наших секрета с разными ролями, ответ провайдера не называет ни
// одного, и пересказ чужой строки без привязки к НАШИМ именам ВЫГЛЯДИТ
// как объяснение, а объяснением не является. Это «пробел не должен
// выглядеть как полнота» применительно к пересказу чужих слов.
//
// ЧТО ПРОВЕРЯЕТСЯ ЗДЕСЬ. Поведение разбора формата и приписки к отказу
// (обычные вызовы функций), затем — порядок в `registerWebhook`
// (проверка ДО обращения к провайдеру) и то, что обе документации
// больше не предписывают base64 для этой переменной.
//
// ЧЕГО ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ. Живой `setWebhook` не вызывается: тест,
// которому нужен настоящий токен бота, не тест. Порядок «проверка до
// fetch» поэтому проверяется чтением исходника — приём честный ровно
// настолько, насколько честно названо, что это чтение текста, а не
// исполнения.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SECRET_GUARDING_THE_COMMAND,
  SECRET_SENT_TO_TELEGRAM,
  TELEGRAM_SECRET_MAX,
  telegramRefusalHint,
  telegramSecretProblem,
} from '../telegram-bot/webhook-secret-format';

const SRC = join(__dirname, '..');
const ROOT = join(__dirname, '..', '..', '..', '..');
const serviceSource = readFileSync(join(SRC, 'telegram-bot', 'telegram-bot.service.ts'), 'utf8');
const envExample = readFileSync(join(SRC, '..', '.env.example'), 'utf8');
const vercelDoc = readFileSync(join(ROOT, 'VERCEL.md'), 'utf8');

/** Значение той же формы, что выдаёт `openssl rand -base64 32`. Своё,
 *  не чужое: настоящих секретов в репозитории не бывает. */
const BASE64_SHAPED = 'Zm9vYmFyL2Jheg+cXV1eHF1dXg=';
/** Та же форма, что выдаёт `openssl rand -hex 32`. */
const HEX_SHAPED = 'a'.repeat(64);
/** Форма значения, полученного через `tr '+/' '-_' | tr -d '='`:
 *  алфавит уже допустимый. Наша проверка обязана его ПРОПУСТИТЬ — иначе
 *  второй заход упёрся бы в нас, а не в несовпадение переменных. */
const TRANSLATED_SHAPED = 'Zm9vYmFyL2Jhegcadeg_cXV1eHF1dXg-ab';

describe('[the-provider-had-rules-nobody-wrote-down] формат secret_token', () => {
  it('значение из `openssl rand -hex 32` подходит', () => {
    expect(telegramSecretProblem(HEX_SHAPED)).toBeNull();
  });

  it('значение из `openssl rand -base64 32` отвергается и лишние символы названы по одному', () => {
    const problem = telegramSecretProblem(BASE64_SHAPED);
    expect(problem).not.toBeNull();
    const message = problem?.message ?? '';
    expect(message.includes('«+»')).toBe(true);
    expect(message.includes('«/»')).toBe(true);
    expect(message.includes('«=»')).toBe(true);
    // Каждый символ перечисляется один раз, а не столько раз, сколько
    // встретился: владелец ищет их глазами, а не считает. Считается
    // именно ПЕРЕЧИСЛЕНИЕ — пояснение после него те же символы
    // называет ещё раз, и это нормально (так первая версия этой
    // проверки и упала).
    const enumerated = message.slice(0, message.indexOf('Telegram принимает'));
    const repeated = telegramSecretProblem('a++++b')?.message ?? '';
    const repeatedEnum = repeated.slice(0, repeated.indexOf('Telegram принимает'));
    expect(enumerated.split('«+»').length - 1).toBe(1);
    expect(repeatedEnum.split('«+»').length - 1).toBe(1);
  });

  it('отказ называет замену, а не только проблему', () => {
    const message = telegramSecretProblem(BASE64_SHAPED)?.message ?? '';
    expect(message.includes('openssl rand -hex 32')).toBe(true);
  });

  it('значение, уже приведённое к допустимому алфавиту, НЕ отвергается', () => {
    expect(telegramSecretProblem(TRANSLATED_SHAPED)).toBeNull();
  });

  it('пустое значение отвергается отдельно от неверного алфавита', () => {
    const message = telegramSecretProblem('')?.message ?? '';
    expect(message.includes('пустое')).toBe(true);
    expect(message.includes('запрещённые символы')).toBe(false);
  });

  it('предел длины — ровно 256: 256 подходит, 257 нет, и длина названа числом', () => {
    expect(TELEGRAM_SECRET_MAX).toBe(256);
    expect(telegramSecretProblem('a'.repeat(TELEGRAM_SECRET_MAX))).toBeNull();
    const message = telegramSecretProblem('a'.repeat(TELEGRAM_SECRET_MAX + 1))?.message ?? '';
    expect(message.includes(String(TELEGRAM_SECRET_MAX + 1))).toBe(true);
    expect(message.includes(String(TELEGRAM_SECRET_MAX))).toBe(true);
  });

  it('обратная проба: проверка опирается на алфавит, а не на длину значения — длинное допустимое проходит, короткое недопустимое нет', () => {
    expect(telegramSecretProblem('A'.repeat(200))).toBeNull();
    expect(telegramSecretProblem('a+b')).not.toBeNull();
  });
});

describe('[the-provider-had-rules-nobody-wrote-down] приписка к отказу Telegram', () => {
  const ILLEGAL = 'Bad Request: secret token contains illegal characters';

  it('две переменные названы разными именами и не совпадают', () => {
    expect(SECRET_SENT_TO_TELEGRAM).toBe('TELEGRAM_WEBHOOK_SECRET');
    expect(SECRET_GUARDING_THE_COMMAND).toBe('SCHEDULER_DISPATCH_SECRET');
    // Через String(): у литеральных типов TS сравнение считает заведомо
    // ложным и отказывается компилировать — а проверить надо значения.
    expect(String(SECRET_SENT_TO_TELEGRAM) === String(SECRET_GUARDING_THE_COMMAND)).toBe(false);
  });

  it('отказ про secret token называет НАШУ переменную и отводит подозрение от секрета заголовка', () => {
    const hint = telegramRefusalHint(ILLEGAL);
    expect(hint.includes(SECRET_SENT_TO_TELEGRAM)).toBe(true);
    expect(hint.includes(SECRET_GUARDING_THE_COMMAND)).toBe(true);
    // Именно это владелец и сделал во втором заходе — поправил не тот.
    expect(/НЕ\s+SCHEDULER_DISPATCH_SECRET/.test(hint)).toBe(true);
  });

  it('приписка про secret token напоминает про редеплой — без него функция читает прежнее значение', () => {
    expect(telegramRefusalHint(ILLEGAL).includes('редеплой')).toBe(true);
  });

  it('отказ про адрес указывает на переменную адреса, а не на секрет', () => {
    const hint = telegramRefusalHint('Bad Request: bad webhook: HTTPS url must be provided');
    expect(hint.includes('API_PUBLIC_BASE_URL')).toBe(true);
    expect(hint.includes(SECRET_SENT_TO_TELEGRAM)).toBe(false);
  });

  it('неузнанный отказ всё равно получает приписку: строка чужая, у нас ничего не изменилось', () => {
    const hint = telegramRefusalHint('Bad Request: something entirely new');
    expect(hint.length > 0).toBe(true);
    expect(hint.includes('ответ Telegram')).toBe(true);
    expect(hint.includes(SECRET_SENT_TO_TELEGRAM)).toBe(true);
  });

  it('приписка не бывает пустой ни на одном входе, включая отсутствующее описание', () => {
    const inputs = [undefined, '', ILLEGAL, 'HTTPS url must be provided', 'что угодно'];
    for (const input of inputs) {
      expect(telegramRefusalHint(input).trim().length > 0).toBe(true);
    }
  });

  it('обратная проба: разбор смотрит на текст отказа, а не выдаёт одну приписку на всё', () => {
    const secretHint = telegramRefusalHint(ILLEGAL);
    const urlHint = telegramRefusalHint('HTTPS url must be provided');
    const unknownHint = telegramRefusalHint('no idea');
    expect(secretHint === urlHint).toBe(false);
    expect(secretHint === unknownHint).toBe(false);
    expect(urlHint === unknownHint).toBe(false);
  });
});

describe('[the-provider-had-rules-nobody-wrote-down] порядок в registerWebhook', () => {
  it('формат проверяется ДО обращения к провайдеру', () => {
    const check = serviceSource.indexOf('telegramSecretProblem(secret)');
    const call = serviceSource.indexOf('setWebhook');
    expect(check > 0).toBe(true);
    expect(call > 0).toBe(true);
    expect(check < call).toBe(true);
  });

  it('отказ проверки говорит, что вебхук НЕ зарегистрирован — состояние у нас и у Telegram прежнее', () => {
    expect(serviceSource.includes('Вебхук НЕ зарегистрирован')).toBe(true);
  });

  it('приписка прикладывается именно к неуспешному ответу, а не ко всякому', () => {
    expect(/ok\s*\?\s*\{[^}]*\}\s*:\s*\{[^}]*telegramRefusalHint/s.test(serviceSource)).toBe(true);
  });

  it('обратная проба: обе зацепки существуют в исходнике по отдельности, то есть сверка порядка не держится на отсутствии строки', () => {
    expect(serviceSource.split('telegramSecretProblem(secret)').length - 1).toBe(1);
    expect(serviceSource.includes('secret_token: secret')).toBe(true);
  });
});

describe('[the-provider-had-rules-nobody-wrote-down] документация больше не порождает нерабочее значение', () => {
  // Проверка СТРУКТУРНАЯ, а не «слова base64 нет». Исправление само
  // цитирует неверную инструкцию — так в этом проекте и принято
  // исправлять: сказать, что было написано раньше. Поэтому требуется,
  // чтобы hex присутствовал, а каждая ИНСТРУКЦИЯ с base64 в блоке
  // Telegram стояла ПОСЛЕ пометки об исправлении.
  const MARK = 'the-provider-had-rules-nobody-wrote-down';

  const telegramEnvBlock = (): string => {
    const start = envExample.lastIndexOf('[job-domain-v2] К-20');
    const end = envExample.indexOf('TELEGRAM_WEBHOOK_SECRET=""');
    return envExample.slice(start, end);
  };
  const vercelSection = (): string => {
    const start = vercelDoc.indexOf('Входящий вебхук бота');
    const end = vercelDoc.indexOf('Инцидент 2026-09-02');
    return vercelDoc.slice(start, end);
  };

  it('.env.example предлагает hex и помечает прежнюю инструкцию как исправленную', () => {
    const block = telegramEnvBlock();
    expect(block.length > 0).toBe(true);
    expect(block.includes('openssl rand -hex 32')).toBe(true);
    const mark = block.indexOf(MARK);
    expect(mark > 0).toBe(true);
    expect(block.indexOf('openssl rand -base64 32') > mark).toBe(true);
  });

  it('.env.example называет вторую переменную, чтобы её не правили вместо первой', () => {
    const block = telegramEnvBlock();
    expect(block.includes('SCHEDULER_DISPATCH_SECRET')).toBe(true);
    expect(block.includes('x-dispatch-secret')).toBe(true);
  });

  it('VERCEL.md предлагает hex в шаге регистрации и помечает прежнюю инструкцию', () => {
    const section = vercelSection();
    expect(section.length > 0).toBe(true);
    expect(section.includes('openssl rand -hex 32')).toBe(true);
    const mark = section.indexOf(MARK);
    expect(mark > 0).toBe(true);
    // Сверяется ИНСТРУКЦИЯ, а не слово. Заголовок исправления сам
    // начинается словами «Не `base64`…» и стоит до пометки — первая
    // версия этой проверки на нём и упала, то есть наказывала
    // цитирование неверной инструкции вместо самой инструкции.
    expect(section.indexOf('openssl rand -base64 32') > mark).toBe(true);
    // И команда, которую надо выполнить, стоит раньше рассказа о том,
    // какая была раньше: читающий сверху вниз первой видит рабочую.
    expect(section.indexOf('openssl rand -hex 32') < section.indexOf('openssl rand -base64 32')).toBe(true);
  });

  it('VERCEL.md разводит две переменные прямо в шаге, где их путают', () => {
    const section = vercelSection();
    expect(section.includes('Telegram его не видит')).toBe(true);
    expect(section.includes('SCHEDULER_DISPATCH_SECRET')).toBe(true);
  });

  it('обратная проба: сверка документации смотрит на реальные файлы — выдуманная пометка в них не находится', () => {
    expect(vercelDoc.includes('zz-no-such-audit-mark')).toBe(false);
    expect(envExample.includes('zz-no-such-audit-mark')).toBe(false);
    expect(vercelDoc.includes(MARK)).toBe(true);
  });
});
