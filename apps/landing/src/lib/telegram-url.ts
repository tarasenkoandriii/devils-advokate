// Единая точка правды для ссылки на бота — используется в Hero и
// FinalCTA. Плейсхолдер по умолчанию, чтобы страница не падала при
// сборке без .env — реальный юзернейм бота подставляется через
// NEXT_PUBLIC_TELEGRAM_BOT_URL при деплое (см. .env.example).
export const TELEGRAM_URL = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL ?? 'https://t.me/';
