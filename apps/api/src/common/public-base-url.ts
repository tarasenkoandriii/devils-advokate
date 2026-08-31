// Пункт [blob-upload] / 2026-08-31 — единое место разбора
// API_PUBLIC_BASE_URL.
//
// ПОВОД. Значение подставлялось в три разных webhook-URL простой
// склейкой строк (`${base}/conversations/webhook/...` в
// ConversationsService, SparringService и MaterialChatService).
// Склейка ломается на самом вероятном способе ввести значение —
// скопировать адрес из адресной строки браузера, где он всегда со
// слэшем на конце. Получается `https://api.example.com//conversations/
// webhook/transcription`; двойной слэш иногда нормализуется роутером, а
// иногда даёт 404 — и тогда разговор навсегда виснет в TRANSCRIBING,
// потому что вебхук с результатом приходит на несуществующий путь.
// Симптом при этом ровно тот же, что у «переменная не задана вовсе»,
// а чинится по-другому.
//
// Три копии проверки — и сам по себе повод: ровно из-за них
// MaterialChatService до повторного аудита 2026-08-30 вообще не
// проверял пустое значение и слал провайдеру «undefined/material-chat-…».
// Одна функция вместо трёх копий закрывает этот класс расхождений.

/** Слэш на конце срезается, потому что вызывающий код всегда добавляет
 * путь, начинающийся со слэша. Пустая строка и пробелы считаются
 * незаданным значением: `API_PUBLIC_BASE_URL=` в панели Vercel — это
 * не «задано пустым», это забыли заполнить. */
export function publicApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.API_PUBLIC_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      'API_PUBLIC_BASE_URL is not set — required to build a webhook URL AssemblyAI can call back',
    );
  }

  const normalized = raw.replace(/\/+$/, '');

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(
      `API_PUBLIC_BASE_URL не разбирается как URL («${normalized}»). Ожидается адрес вида https://ваш-api.vercel.app, без пути и без слэша на конце.`,
    );
  }

  // http:// отсекается не из формализма: AssemblyAI шлёт на этот адрес
  // результат расшифровки разговора, и отправлять его открытым текстом
  // — не тот компромисс, который стоит делать молча. Исключение для
  // локальной разработки: там http://localhost — норма (и снаружи он
  // всё равно недостижим, для вебхуков нужен туннель).
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `API_PUBLIC_BASE_URL должен быть https (сейчас «${url.protocol}//»). AssemblyAI возвращает по этому адресу расшифровку разговора.`,
    );
  }

  // Путь в базовом адресе — почти всегда признак того, что скопировали
  // не тот URL: адрес конкретной страницы вместо корня приложения.
  // Молча отрезать его нельзя (вдруг API и правда живёт на подпути),
  // поэтому только явная ошибка с объяснением.
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `API_PUBLIC_BASE_URL содержит путь («${url.pathname}»). Нужен корневой адрес API-проекта, например https://ваш-api.vercel.app — проверьте, что скопирован адрес API, а не страницы админки или TMA.`,
    );
  }

  return normalized;
}
