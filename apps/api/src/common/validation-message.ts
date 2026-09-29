// Пункт [refusal-spoke-english] 2026-09-24 — самый частый отказ продукта
// говорил с человеком по-английски и внутренними именами полей.
//
// НАЙДЕННОЕ. Пункт [draft-spoke-machine] завёл правило: текст человеку
// пишется на языке интерфейса, а не машинными словами. Пункт
// [letters-were-not-the-language] нашёл, что правило измеряло язык по
// буквам, и починил измерение. Оба смотрели на ОДИН канал — строковые
// литералы внутри `new …Exception(…)`.
//
// А самый частый отказ API — не литерал вовсе. Глобальный
// `ValidationPipe` исполняет 179 декораторов class-validator, и при
// нарушении отдаёт СВОИ сообщения по умолчанию:
//
//   rawText must be shorter than or equal to 30000 characters
//   text should not be empty
//
// Фильтр ошибок склеивает их через «; », TMA рисует `err.message` как
// есть. Человек, вставивший слишком длинный бриф, читает английскую
// фразу с именем поля из кода — и не узнаёт ни что превысил, ни
// насколько.
//
// ПОЧЕМУ НЕ ДОПИСАТЬ `message:` В 179 ДЕКОРАТОРАХ. Сто семьдесят девять
// копий одной заботы разъедутся так же, как разъезжались проверки
// согласий и сравнения секретов. Здесь один шлюз — тот же приём, что
// `ai-error-passthrough.ts`.
//
// ЧЕСТНАЯ ГРАНИЦА, и она взята у `field-labels.ts` в TMA: НЕИЗВЕСТНОЕ
// ПОЛЕ НАЗЫВАЕТСЯ КАК ЕСТЬ. Придумать подпись полю, смысла которого я
// не проверил, — соврать увереннее, чем показать `rawText`. И
// неизвестное ограничение отдаётся СВОИМ английским текстом: машинная
// фраза честнее выдуманной русской.

import { ValidationError } from 'class-validator';
import { BadRequestException } from '@nestjs/common';

/** Подписи полей запроса — словами продукта. Только те, что прослежены
 * до контроллера; остальные честно остаются латиницей. */
export const REQUEST_FIELD_LABEL: Record<string, string> = {
  rawText: 'текст брифа',
  text: 'текст',
  title: 'заголовок',
  note: 'заметка',
  description: 'описание',
  displayName: 'имя',
  url: 'ссылка',
  stance: 'сторона (за/против)',
  reason: 'причина',
  source: 'источник',
  query: 'запрос',
  participantId: 'участник',
  withdrawToken: 'ключ доступа по ссылке',
  confirmation: 'подтверждение',
  goalDescription: 'описание цели',
  cvText: 'текст резюме',
  answers: 'ответы',
  questions: 'вопросы',
  direction: 'направление голоса',
  amount: 'сумма',
  currency: 'валюта',
  dueDate: 'срок',
  deadline: 'срок',
  category: 'категория',
  status: 'статус',
};

export function labelForField(field: string): string {
  return REQUEST_FIELD_LABEL[field] ?? field;
}

/** Число из стандартного сообщения class-validator. Аргументы
 * ограничения наружу не отдаются, а число в тексте есть всегда —
 * поэтому берётся оттуда, и это записано прямо, а не спрятано. */
function numberIn(message: string): string | null {
  const m = /(\d[\d\s]*)/.exec(message);
  return m ? m[1].trim() : null;
}

/** Ограничение → фраза на языке интерфейса. Неизвестное ограничение
 * возвращает `null`: тогда отдаётся исходный текст. */
function phraseFor(kind: string, message: string): string | null {
  const n = numberIn(message);
  switch (kind) {
    case 'isNotEmpty':
      return 'не может быть пустым';
    case 'maxLength':
      return n ? `не длиннее ${n} знаков` : 'слишком длинный';
    case 'minLength':
      return n ? `не короче ${n} знаков` : 'слишком короткий';
    case 'arrayMaxSize':
      return n ? `не больше ${n} элементов` : 'слишком много элементов';
    case 'arrayMinSize':
      return n ? `не меньше ${n} элементов` : 'слишком мало элементов';
    case 'isString':
      return 'должно быть текстом';
    case 'isBoolean':
      return 'должно быть «да» или «нет»';
    case 'isInt':
    case 'isNumber':
      return 'должно быть числом';
    case 'isArray':
      return 'должно быть списком';
    case 'max':
      return n ? `не больше ${n}` : 'слишком большое значение';
    case 'min':
      return n ? `не меньше ${n}` : 'слишком маленькое значение';
    case 'isUrl':
      return 'должно быть ссылкой';
    case 'isIso8601':
      return 'должно быть датой';
    case 'isEnum':
    case 'isIn':
      return 'недопустимое значение';
    case 'isObject':
      return 'должно быть объектом';
    default:
      return null;
  }
}

/** Один разбор ошибки валидации → фразы «поле — что не так». */
export function describeValidationError(error: ValidationError, parent = ''): string[] {
  const path = parent ? `${parent}.${error.property}` : error.property;
  const out: string[] = [];
  for (const [kind, message] of Object.entries(error.constraints ?? {})) {
    const phrase = phraseFor(kind, String(message));
    // Неизвестное ограничение отдаётся своим текстом целиком: он
    // машинный, но правдивый, а выдуманная русская фраза была бы
    // догадкой о том, чего я не проверил.
    out.push(phrase ? `${labelForField(path)} — ${phrase}` : String(message));
  }
  for (const child of error.children ?? []) out.push(...describeValidationError(child, path));
  return out;
}

/** Что увидит человек вместо «rawText must be shorter than…». */
export function validationMessage(errors: ValidationError[]): string {
  const parts = errors.flatMap((e) => describeValidationError(e));
  if (parts.length === 0) return 'Запрос не прошёл проверку';
  return `Проверьте введённое: ${parts.join('; ')}`;
}

export function validationException(errors: ValidationError[]): BadRequestException {
  return new BadRequestException(validationMessage(errors));
}
