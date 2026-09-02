// Пункт [deep-links] 2026-09-02 — ИСПРАВЛЕНИЕ АУДИТА.
//
// НАЙДЕНО. Четыре места возвращали пользователю ссылку-приглашение с
// ЛИТЕРАЛОМ `<bot>` в адресе:
//
//   t.me/<bot>?start=share_<токен>          передача кандидата
//   t.me/<bot>?start=team_share_<токен>     передача пула
//   t.me/<bot>?start=team_<токен>           приглашение в команду
//   t.me/<bot>?start=group_<токен>          инвайт в инвест-группу
//
// Имени бота не было ни в env, ни в конфиге — то есть подставить его
// было неоткуда. TMA показывала строку как готовую ссылку. Рекрутер
// жал «поделиться кандидатом», получал ссылку в никуда, а токен при
// этом уже создавался и тикал 72 часа: фича выглядела сломанной
// целиком, хотя весь остальной путь работал.
//
// Здесь — одна функция на все четыре места. Не задано окружение —
// честная 503 с именем недостающей переменной, а не битая ссылка:
// «конфигурация не должна выглядеть как отказ фичи» работает и в
// обратную сторону — отказ фичи не должен выглядеть как рабочая ссылка.
import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Ссылка запуска Mini App / бота с полезной нагрузкой.
 *
 * Две поддерживаемые формы, потому что у проекта живут обе:
 *  • TELEGRAM_MINI_APP_URL=https://t.me/<bot>/<app> — прямая ссылка на
 *    Mini App, параметр читается как `startapp`;
 *  • TELEGRAM_BOT_USERNAME=<bot> — ссылка на бота, параметр `start`.
 * Первая имеет приоритет: она открывает приложение сразу, без экрана
 * чата.
 */
export function buildStartDeepLink(payload: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(payload)) {
    // Не пользовательский ввод, а наши же токены (base64url) с
    // префиксом — несоответствие означает ошибку в коде, не в данных.
    throw new Error(`Недопустимая нагрузка deep-link: «${payload}» (допустимы A-Za-z0-9_- до 64 символов)`);
  }

  const miniApp = env.TELEGRAM_MINI_APP_URL?.trim();
  if (miniApp) {
    return `${miniApp.replace(/\/+$/, '')}?startapp=${payload}`;
  }

  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (botUsername) {
    return `https://t.me/${botUsername}?start=${payload}`;
  }

  throw new ServiceUnavailableException(
    'Ссылка-приглашение не может быть построена: не задана ни TELEGRAM_MINI_APP_URL (https://t.me/бот/приложение), ' +
      'ни TELEGRAM_BOT_USERNAME. Задайте одну из них в окружении API — иначе ссылка вела бы в никуда.',
  );
}
