# Devil's Advocate — короткие команды для локального докер-стенда.
# Подробности и разбор «что происходит» — в DOCKER.md.
#
# Смысл этого файла ровно один: --env-file .env.docker -f docker-compose.dev.yml
# — три флага, которые нужно не забыть в КАЖДОЙ команде. Забытый
# --env-file не ломается громко: стенд поднимется, но все ключи внешних
# API окажутся пустыми, и разбираться в этом придётся уже по симптомам.

COMPOSE = docker compose --env-file .env.docker -f docker-compose.dev.yml

.PHONY: help env up down restart logs ps reset seed-dev shell-api psql test typecheck lint ci

help:
	@echo "make up         — поднять весь стенд (api + tma + admin + landing + postgres)"
	@echo "make down       — остановить (данные БД сохраняются)"
	@echo "make reset      — остановить и УДАЛИТЬ том с БД, затем поднять заново"
	@echo "make logs       — хвост логов всех сервисов"
	@echo "make ps         — статус контейнеров"
	@echo "make seed-dev   — перезапустить dev-сид (пользователь dev-<id> с правами)"
	@echo "make shell-api  — shell внутри контейнера api"
	@echo "make psql       — psql внутри контейнера postgres"
	@echo "make test       — тесты apps/api внутри контейнера"
	@echo "make typecheck  — tsc по apps/api внутри контейнера"
	@echo "make lint       — ESLint по всему монорепозиторию (на хосте)"
	@echo "make ci         — lint + typecheck + тесты, как в CI (сборки — отдельно, npm run build)"

# Создаётся автоматически при первом up — чтобы «забыл скопировать
# .env.docker.example» не был отдельным шагом, на котором спотыкаются.
env:
	@test -f .env.docker || (cp .env.docker.example .env.docker && echo "Создан .env.docker из .env.docker.example — ключи внешних API можно вписать позже.")

up: env
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  TMA      → http://localhost:3001   (вход автоматический, X-Dev-User-Id)"
	@echo "  Админка  → http://localhost:3002   (кнопка «Войти как dev-…» на /login)"
	@echo "  Лендинг  → http://localhost:3003"
	@echo "  API      → http://localhost:3000"
	@echo "  Adminer  → http://localhost:8080   (сервер postgres, логин/пароль/база: devils_advocate)"

down: env
	$(COMPOSE) down

restart: env
	$(COMPOSE) restart api

logs: env
	$(COMPOSE) logs -f --tail=100

ps: env
	$(COMPOSE) ps

# -v удаляет том с данными Postgres — единственный честный способ
# получить чистую БД, если схема разъехалась после правки schema.prisma
# (db push без миграций умеет не всё).
reset: env
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build

seed-dev: env
	$(COMPOSE) run --rm api npx ts-node prisma/seed-dev.ts

shell-api: env
	$(COMPOSE) exec api bash

psql: env
	$(COMPOSE) exec postgres psql -U devils_advocate -d devils_advocate

test: env
	$(COMPOSE) run --rm api npm test

# Только apps/api: образ api содержит ровно его исходники (три Next-
# приложения живут в своих образах). Полный монорепозиторный
# `npm run typecheck` — на хосте, он не требует ни БД, ни контейнеров.
typecheck: env
	$(COMPOSE) run --rm api npm run typecheck

# ── Проверки перед пушем (на хосте, без докера) ──
# Три из пяти джоб .github/workflows/ci.yml одной командой: красный CI
# после пуша — почти всегда «не запустил это локально». Сборочная джоба
# (nest + три next) сюда не входит намеренно — она медленная; при
# правках next.config/зависимостей гоняйте ещё `npm run build`.
# Требуется однократный npm ci и prisma generate (см. README).

lint:
	npm run lint

ci:
	npm run ci
