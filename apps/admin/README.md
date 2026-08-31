# apps/admin

Единая админ-панель Devil's Advocate — Next.js 14 App Router. Реализовано по
`docs/devils-advocate-admin-panel-tz.md`. Backend-фундамент (аутентификация,
`AdminSession`, разделение guard'ов, управление пользователями) — в `apps/api`,
Пункт `[admin-panel]` (см. `apps/api/prisma/README.md`).

## Вкладки

- **Модерация → Библиотека** (`isLibraryModerator`) — очередь `LibraryEntry`.
- **Модерация → Заведения** (`isVenueModerator`) — заявки + монетизация одобренных
  заведений (реферальная плата, приоритетное размещение, сводка по броням).
- **Модерация → Пользователи** (`isOperator`) — список, детали, два независимых уровня
  ограничения аккаунта: частичное (`isRestricted`, §8 юридического чек-листа, п.11) и
  полное (`isBlocked`, Пункт `[full-block]`).
- **Промпты** (`isOperator`) — Prompt Registry lifecycle (draft → testing → active),
  запуск evaluation, rollback.
- **Телеметрия** (`isOperator`) — сводка по фиче/модели, детализация вызовов.

## Аутентификация

Telegram Login Widget, НЕ `TelegramAuthGuard`/initData (тот работает только внутри
Telegram WebView) — см. обоснование в самом ТЗ, раздел 2. После входа backend ставит
httpOnly cookie `admin_session` на своём домене; `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`
должен указывать на того же бота, чей `TELEGRAM_BOT_TOKEN` настроен на `apps/api`.

## Локальный запуск

```bash
cp .env.example .env.local
npm install
npm run dev  # порт 3002 — не пересекается с apps/api (3000)/apps/tma
```

`NEXT_PUBLIC_API_BASE_URL` должен указывать на реально запущенный `apps/api` —
без него ни одна вкладка не сможет ничего загрузить.

## Честные ограничения этого прохода (см. TODO.md)

- Мобильная адаптация не проектировалась — десктоп-браузер по своей природе
  (тот же явный отказ, что в самом ТЗ, раздел 6).
- `/prompts/page.tsx` требует ручного ввода `promptId` — в API-контракте нет
  эндпоинта "список всех promptId", только поиск по уже известному значению
  (то же пространство строк, что `taskType` в телеметрии).
