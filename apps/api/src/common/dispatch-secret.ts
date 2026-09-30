// Пункт [the-registry-promised-401-and-gave-500] 2026-09-30 — один
// способ проверить общий секрет server-to-server, с честным отказом при
// не настроенной переменной.
//
// НАЙДЕННОЕ. Реестр незащищённых поверхностей (`common/public-surfaces.ts`)
// описывает этот класс маршрутов словами «Общий секрет в заголовке…
// Без секрета — 401». Правдой это было только для ОТСУТСТВУЮЩЕГО
// ЗАГОЛОВКА. Если не выставлена сама переменная окружения,
// `secrets.resolve()` бросает обычный `Error`, а фильтр исключений
// переводит его в **500 «Internal server error»** — у пяти контроллеров
// из шести. Оператор, забывший переменную, получал от своей же
// pg_cron-джобы «внутреннюю ошибку» и шёл искать поломку в коде вместо
// того, чтобы выставить переменную; в `job_run_details` при этом лежит
// тот же 500 без единого слова о причине.
//
// Утверждение о проверке, записанное внутри самой проверки, перестало
// быть правдой — самая частая находка собственных сверок этого проекта.
// Здесь она нашлась в реестре, который и завели, чтобы описывать такие
// маршруты честно.
//
// ПРАВИЛЬНЫЙ ОТКАЗ УЖЕ СУЩЕСТВОВАЛ — у `TelegramBotController`, ровно
// один из шести: `resolve(...).catch(() => null)` и 503 с именем
// переменной. «Правило было, просто не везде» в чистом виде, поэтому
// здесь оно становится одним местом, а не шестью копиями.
//
// ДВА РАЗНЫХ ОТКАЗА, И РАЗНИЦА СМЫСЛОВАЯ:
//   401 — секрет прислан и не совпал: звонящий не тот, кем назвался.
//   503 — секрет не настроен У НАС: маршрут не работает по нашей вине,
//         и звонящий здесь ни при чём. Повторять запрос бессмысленно,
//         пока переменную не выставят.

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { safeSecretEqual } from './timing-safe-equal';

/** Минимум, который нужен от SecretsService: разрешение ссылки в
 *  значение. Интерфейс, а не класс, — чтобы проверка не тянула за собой
 *  модуль секретов. */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

/**
 * Проверяет общий секрет server-to-server маршрута.
 *
 * @param secrets  провайдер секретов
 * @param ref      имя переменной окружения (оно же попадёт в текст 503)
 * @param provided значение заголовка `x-dispatch-secret`
 *
 * @throws ServiceUnavailableException переменная не настроена (503)
 * @throws UnauthorizedException       секрет не совпал (401)
 */
export async function assertSharedSecret(
  secrets: SecretResolver,
  ref: string,
  provided: string | undefined,
): Promise<void> {
  const expected = await secrets.resolve(ref).catch(() => null);
  if (!expected) {
    throw new ServiceUnavailableException(
      `${ref} не настроен — этот маршрут отключён (fail closed). Выставьте переменную окружения.`,
    );
  }
  // `safeSecretEqual` сам отказывает на пустом `provided` и сравнивает
  // за постоянное время; длина секрета утекает намеренно — обоснование
  // в шапке `timing-safe-equal.ts`.
  if (!safeSecretEqual(provided ?? '', expected)) {
    throw new UnauthorizedException('Invalid dispatch secret');
  }
}
