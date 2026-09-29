# Реестр репозиториев

Для каждого репозитория — что подтверждено пользователем. Всё, что
здесь помечено «не подтверждено», спрашивается у пользователя при первой
записи (одним вопросом), а не угадывается: запись в чужую папку
необратима по последствиям так же, как удаление.

Общее для всех: перевалочная папка на Маке — `/Users/macbook/work`
(в шелле устройства `$HOME/mnt/work`). Архив всегда кладётся туда, в
репозиторий — никогда.

---

## viral4creators — подтверждено

| Поле | Значение |
|---|---|
| Папка на Маке | `/Users/macbook/work/viral4creators` |
| В шелле устройства | `$HOME/mnt/viral4creators` (скрипт найдёт сам) |
| Как узнать в песочнице | `backend/`, `frontend/`, `admin/`, `landing/`, `live-login-relay/`, `scripts/check-docs.mjs` |
| «Зелёное» целиком | `make ci` из корня |
| То же по шагам CI | бэкенд: `npx tsc --noEmit`, `npx eslint "src/**/*.ts" --max-warnings 0`, `npx jest --json --outputFile=jest-results.json`, затем `node scripts/check-docs.mjs` из корня; фронтенд: `npx tsc --noEmit -p tsconfig.json`, `npm run typecheck:scripts`, `npm run lint`, `npm test` |
| Счётчики в документах | `README.md`, `doc/CI.md`, `doc/ACCEPTANCE-CHECKLIST.md`, `doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`, `doc/TELEGRAM-ADMIN.md` — их сверяет `check-docs` |
| Prettier | только по затронутым файлам бэкенда; по `landing/` глобально — нет; по `admin/` — никогда (нет конфига) |
| Записи этапа | ТЗ в `docs-tz/…`, `doc/TODO.md`, текст коммита в `.git-commit-N.txt` |
| Известный шум | `backend/src/modules/assistant/knowledge/*` после `prebuild` — меняется только метка времени, вернуть к исходнику |
| Под `.gitignore`, но отслеживаются | `*.env.example` (правило `.env*`) — везти |

---

## Devil's Advocate — подтверждено 2026-09-29

| Поле | Значение |
|---|---|
| Папка на Маке | `/Users/macbook/work/devils-advocate-monorepo` |
| В шелле устройства | `$HOME/mnt/devils-advocate-monorepo` |
| Как узнать в песочнице | `apps/api` (NestJS), `apps/tma`, `apps/admin`, `apps/landing`, `scripts/run-standalone-specs.js`, `TODO.md` из разделов «## Пункт [метка] ДАТА» |
| «Зелёное» целиком | `npm run ci` из корня (lint + typecheck + test) |
| То же по шагам CI (`.github/workflows/ci.yml`) | `npm run lint`; `npm run typecheck` (четыре приложения, спеки ВНУТРИ тайпчека); `npm test`; `npm run build --workspace=apps/{api,tma,admin,landing}`; `npm run prisma:validate --workspace=apps/api` |
| Два раннера тестов | jest в `apps/api` и собственный standalone-раннер (`node scripts/run-standalone-specs.js src/__tests__`) для спек, которые jest не запускает. **Корневой `npm test` не включает admin** — ровно как CI; его спеки гоняются `npm test` в `apps/admin` |
| Prettier | **не запускать**: своего конфига нет ни в одном пакете, форматирование держит ESLint |
| Записи этапа | `TODO.md` — новый раздел «## Пункт [метка] ДАТА» СВЕРХУ файла; `README.md` — «**Дополнение ГГГГ-ММ-ДД, <порядковое> (Пункт [метка] в `TODO.md`)**», нумерация сквозная |
| Счётчики в документах | своего сверщика (как `check-docs`) нет; числа в разделах — часть текста этапа |

**Что в песочнице не проходит и это не дефект.** `npx prisma validate` и
`prisma generate` падают на скачивании движка: шлюз отвечает 403 на
`binaries.prisma.sh` (`PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` не
помогает — 403 и на самом движке). `next build` в `apps/landing` падает на
`next/font`: Unbounded тянется с `fonts.googleapis.com`. Обе джобы CI на
GitHub с сетью проходят; в отчёте это надо называть пределом среды, а не
красным состоянием. Синтаксис схемы частично держит
`schema-conventions.spec.ts` внутри jest.

**Только на Маке — не везти и не удалять:** `apps/api/.env` (реальные
ключи); семь исходных `.png` в `apps/landing/public/images` (в песочнице
лежат только `.webp`); пустой `intake_attribution_2026_09_02.sql` в корне.

**Известное расхождение, названное владельцу 2026-09-29:**
`apps/api/src/common/webhook/assemblyai-webhook.guard.ts` и его спека
есть в репозитории, но вытеснены `SttWebhookGuard` (тот держит старый
заголовок ради задач в полёте) и не импортируются ничем, кроме
собственной спеки. Если их однажды не окажется в песочнице — это не
пропажа, а тот же остаток.

**Под `.gitignore`, но отслеживаются:** `apps/*/.env.example` (правило
`.env`), `.env.docker.example`.

**Как сюда приезжало раньше.** До 2026-09-29 этапы возились целым
снимком дерева (zip в `_to_delete/`), а не списком изменённых файлов.
Так репозиторий получал ВСЁ, но в нём оставались архивы, видимые в
`git status`; 2026-09-29 они удалены с разрешения владельца, папка
`_to_delete/` убрана. Дальше — обычная процедура скилла.

---

## Остальные проекты — путь не подтверждён

Проекты пользователя, для которых запись на диск ещё не делалась:
SilverFinance, Solar Shop (солнечная платформа), ОРБІТА (ATM-travel),
Caller ID, RoadScout/BTW, Volia. Стек у всех близкий
(NestJS, Next.js, Prisma, Vercel, часто монорепо с TMA), но папки на
Маке и команды проверки у каждого свои.

Перед первой записью в любой из них:

1. **Спроси папку репозитория на Маке** — одним вопросом, с догадкой
   `/Users/macbook/work/<имя>` как вариантом, но не как фактом.
2. **Команду «зелёного» выведи из копии в песочнице**, а не спрашивай:
   `.github/workflows/*.yml`, `Makefile`, `scripts` в `package.json`
   корня и пакетов. Прогони то, что там написано, в том же порядке.
3. **Prettier** — только по затронутым файлам и только в пакетах, где
   есть свой конфиг (`.prettierrc*` или поле `prettier` в
   `package.json`). Нет конфига — не запускать.
4. **Счётчики в документах** проверяй, только если в репозитории есть
   свой сверщик (как `check-docs` у viral4creators).

Известное из прошлых работ (использовать для узнавания, не как пути):

- **Solar Shop** — монорепо `apps/api`, `apps/web`, `apps/admin`,
  `apps/tma`, пакет `@solar-shop/db`. Скомпилированный `index.js` рядом
  с `index.ts` в пакете БД — артефакт сборки (закрыт `.gitignore`), не
  везти.

---

## Как дописать реестр

После первой успешной записи в новый репозиторий предложи пользователю
одной строкой добавить его сюда: папка на Маке, признаки, команда
«зелёного», особенности prettier и шум. Если он согласен — допиши
раздел по образцу viral4creators и пересобери скилл
(`package_skill.py`), чтобы следующая запись шла без вопросов.
