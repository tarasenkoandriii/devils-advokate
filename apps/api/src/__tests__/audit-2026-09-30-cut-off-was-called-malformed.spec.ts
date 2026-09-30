// Пункт [cut-off-was-called-malformed] 2026-09-30 — «ответа нет» и
// «ответ не разобран» обязаны звучать по-разному, и так в ОБОИХ
// приложениях.
//
// НАЙДЕННОЕ. Тело, которое не разобралось как JSON, давало одну фразу
// на все случаи — «Сервер вернул некорректный ответ». Самый частый
// случай при этом не «некорректный ответ», а ОТСУТСТВИЕ ответа:
// платформа обрывает функцию на пределе и отдаёт свою страницу 504. То
// есть человеку сообщалось утверждение о сервере, которое не было
// правдой: сервер ничего некорректного не вернул, запрос был прерван.
//
// И вторая половина, чисто механическая: фраза содержит кириллицу, а
// `humanizeApiError` возвращает русские сообщения дословно — значит
// ветка «Сбой на нашей стороне» для статусов 5xx при платформенном
// обрыве не достигалась НИКОГДА. Ветка существовала и была недостижима
// ровно в том случае, для которого писалась.
//
// ЧТО СТОРОЖИТСЯ ЗДЕСЬ. Поведение проверяется в приложении, которому
// принадлежит (`apps/tma/src/__tests__/cut-off-was-called-malformed.spec.ts`
// — восемь проверок на текстах и на адресе API). Снаружи проверяется
// только то, что изнутри одного приложения не видно: что список
// статусов обрыва у двух копий ОДИН И ТОТ ЖЕ и что прежняя фраза не
// осталась ни в одном из двух мест.

import { readFileSync } from 'fs';
import { join } from 'path';

const MONOREPO = join(__dirname, '..', '..', '..', '..');
const COPIES = ['apps/tma/src/lib/api.ts', 'apps/admin/src/lib/admin-api.ts'];
const OLD_SENTENCE = "throw new ApiRequestError('Сервер вернул некорректный ответ'";

function read(rel: string): string {
  return readFileSync(join(MONOREPO, rel), 'utf8');
}

/** Числа из `new Set([...])` у CUT_OFF_STATUSES. */
function cutOffStatuses(src: string): number[] {
  const m = /const CUT_OFF_STATUSES = new Set\(\[([0-9,\s]+)\]\)/.exec(src);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

describe('Пункт [cut-off-was-called-malformed]: обрыв по времени — не «некорректный ответ»', () => {
  it('КЛЮЧЕВОЕ ПРАВИЛО: прежняя фраза не бросается ни в одном из двух приложений', () => {
    for (const copy of COPIES) {
      expect(read(copy).includes(OLD_SENTENCE)).toBe(false);
      // И на её месте — разбор по статусу, а не другая общая фраза.
      expect(read(copy).includes('throw new ApiRequestError(nonJsonMessage(response.status), response.status)')).toBe(true);
    }
  });

  it('список статусов обрыва у двух копий совпадает поимённо', () => {
    const [tma, admin] = COPIES.map((c) => cutOffStatuses(read(c)));
    expect(tma.length > 0).toBe(true);
    expect(admin).toEqual(tma);
    // 504 — ровно тот, который отдаёт платформа при пределе функции;
    // без него правило не покрывает случай, ради которого написано.
    expect(tma.includes(504)).toBe(true);
  });

  it('у каждой копии текст обрыва отличается от текста «не разобран»', () => {
    for (const copy of COPIES) {
      const src = read(copy);
      const cutOff = /if \(CUT_OFF_STATUSES\.has\(httpStatus\)\) \{\s*return '([^']+)'/.exec(src);
      const notParsed = /if \(httpStatus >= 500\) \{\s*return '([^']+)'/.exec(src);
      expect(cutOff !== null).toBe(true);
      expect(notParsed !== null).toBe(true);
      expect(cutOff![1] === notParsed![1]).toBe(false);
      // Ни один из двух не утверждает, что сервер что-то вернул.
      for (const text of [cutOff![1], notParsed![1]]) {
        expect(text.includes('Сервер вернул')).toBe(false);
        expect(/[А-Яа-я]/.test(text)).toBe(true);
      }
    }
  });

  it('вторая копия названа копией и указывает на первую', () => {
    expect(read('apps/admin/src/lib/admin-api.ts').includes('apps/tma/src/lib/api.ts')).toBe(true);
  });

  it('текст обрыва в мини-приложении говорит о израсходованном лимите, в админке — нет', () => {
    // Различие намеренное и названное: операторские действия суточный
    // потолок человека не тратят, и говорить оператору про лимит
    // значило бы сообщать ему неправду о его же действии.
    const tma = /if \(CUT_OFF_STATUSES\.has\(httpStatus\)\) \{\s*return '([^']+)'/.exec(read(COPIES[0]))![1];
    const admin = /if \(CUT_OFF_STATUSES\.has\(httpStatus\)\) \{\s*return '([^']+)'/.exec(read(COPIES[1]))![1];
    expect(tma.includes('лимит')).toBe(true);
    expect(admin.includes('лимит')).toBe(false);
    // Но оба называют главное: результата нет, состояние надо сверить.
    expect(tma.includes('прерван')).toBe(true);
    expect(admin.includes('прерван')).toBe(true);
  });
});
