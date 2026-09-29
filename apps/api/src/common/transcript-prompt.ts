// Сверка «ссылка на реплику» 2026-09-04 — как транскрипт попадает в промпт
// и как ответ модели возвращается к реальным репликам.
//
// Раньше каждая реплика уходила модели со своим `cuid` в квадратных
// скобках (`[id=cmf3k2l9x0001abcdefghij] текст`), а ответ содержал такой
// же id. Отсюда два разных дефекта, и оба закрывает одно решение.
//
// ПЕРВЫЙ — ссылка, которой нет. Пять доменных сервисов (health,
// family-law, investment, dtp, interview-pool-relevance) сохраняли
// `sourceSegmentId` из ответа модели КАК ЕСТЬ, не проверяя, что такая
// реплика существует. У interview-pool это особенно заметно: правило
// «позиция кандидата не сохраняется без реплики-источника» проверяло, что
// поле НЕ ПУСТОЕ, — выдуманный id проходил его насквозь. Разбор
// консультации мог сослаться на реплику, которой врач не говорил, и
// человек увидел бы «источник» у утверждения, которого не было. Два
// сервиса того же класса (turning-points, manipulation-detector) сверку с
// реальными репликами делали с самого начала: правило в проекте было, но
// не везде.
//
// ВТОРОЙ — цена. `cuid` это 25 символов; с обёрткой выходит 27–31 символ
// служебного текста НА КАЖДУЮ реплику, а у разбора расхождений ещё и
// `(personId=…)` — вместе до ~65. Реплика расшифровки короткая (обычно
// 40–90 символов), то есть идентификаторы занимали от четверти до
// половины всего промпта. Это токены в каждом разборе каждого разговора,
// оплаченные владельцем ключа, — и они же приближали упор в общий потолок
// длины запроса (`MAX_USER_PROMPT_CHARS`), после которого длинный
// разговор не разбирается вовсе.
//
// Решение — порядковый номер вместо идентификатора. Модель видит `[7]`,
// возвращает `7`, сервер переводит номер обратно в настоящий id. Выдумать
// «номер 900» в разговоре из 200 реплик модель по-прежнему может — но
// такая выдумка ВИДНА и отбрасывается здесь, а не сохраняется как
// источник.

/** Реплика в том виде, в каком она нужна промпту. */
export interface PromptSegment {
  id: string;
  text: string;
  participant?: { diarizationLabel?: string | null; personId?: string | null } | null;
}

export interface NumberedTranscript {
  /** Готовый текст для промпта: по строке на реплику, с номером. */
  text: string;
  /** Номер → настоящий id реплики. */
  byRef: Map<number, string>;
  /** Сколько служебных символов сэкономлено против прежнего формата с
   * `cuid` — считается, чтобы экономия была измеримой, а не заявленной. */
  savedChars: number;
}

export interface NumberedOptions {
  /** Добавлять ли метку говорящего («Иван: …»). */
  withSpeaker?: boolean;
  /** Добавлять ли `(personId=…)` — нужно только разбору расхождений,
   * который связывает реплику с конкретным человеком проекта. */
  withPersonId?: boolean;
}

const OLD_ID_WRAPPER = '[id=] '.length; // сколько занимала обёртка вокруг cuid

export function numberedTranscript(segments: PromptSegment[], options: NumberedOptions = {}): NumberedTranscript {
  const byRef = new Map<number, string>();
  const lines: string[] = [];
  let savedChars = 0;

  segments.forEach((segment, index) => {
    const ref = index + 1;
    byRef.set(ref, segment.id);
    const speaker = options.withSpeaker ? `${segment.participant?.diarizationLabel ?? 'speaker'}: ` : '';
    const person =
      options.withPersonId && segment.participant?.personId ? ` (personId=${segment.participant.personId})` : '';
    lines.push(`[${ref}]${person ? ` ${person.trim()}` : ''} ${speaker}${segment.text}`);
    savedChars += segment.id.length + OLD_ID_WRAPPER - (String(ref).length + 2 + 1);
  });

  return { text: lines.join('\n'), byRef, savedChars };
}

/** Номер из ответа модели → настоящий id реплики, или null.
 *
 * Терпимо к форме («7», 7, «[7]»), нетерпимо к содержанию: номер вне
 * диапазона — это выдумка, и она отбрасывается. Возврат null означает
 * «источника нет», а не «источник неизвестен»: вызывающий обязан решить,
 * что делать с находкой без источника, и в этом проекте ответ везде один
 * — такая находка не сохраняется. */
export function resolveSegmentRef(byRef: Map<number, string>, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  const match = /^\[?(\d{1,6})\]?$/.exec(text);
  if (!match) return null;
  return byRef.get(Number(match[1])) ?? null;
}
