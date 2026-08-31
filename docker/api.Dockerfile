# Devil's Advocate — apps/api для локального докер-стенда (DOCKER.md).
#
# Образ ОДИН и тот же для сервиса api и для одноразового api-init
# (миграция+сид) — разные только команды запуска. Отдельный «init-образ»
# означал бы вторую сборку тех же зависимостей и второй Prisma-клиент,
# который может разъехаться со схемой основного контейнера.
#
# Почему bookworm-slim, а не alpine: Prisma 5 официально поддерживает
# musl только через отдельный бинарь движка (linux-musl-openssl-3.0.x),
# и любое расхождение версии OpenSSL в alpine выливается в загадочное
# "Unable to require libquery_engine" уже во время выполнения. Дебиановый
# slim тяжелее на ~50 МБ и не имеет этого класса проблем вообще — для
# дев-стенда это правильный размен.
FROM node:22-bookworm-slim

# openssl — рантайм-зависимость движка Prisma (не сборочная);
# postgresql-client — pg_isready/psql для entrypoint-скрипта, которым
# init-контейнер ждёт готовности БД; ca-certificates — HTTPS-вызовы
# внешних API (OpenAI/AssemblyAI/YouTube) из контейнера.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl postgresql-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Слой зависимостей отдельно от исходников: package*.json меняются
# редко, src — постоянно, поэтому npm ci не переигрывается на каждой
# правке кода. package-lock.json — корневой (npm workspaces держит один
# lock на монорепо), поэтому копируются манифесты ВСЕХ воркспейсов:
# без любого из них npm ci откажется ставить (lock описывает всё дерево).
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/tma/package.json ./apps/tma/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/landing/package.json ./apps/landing/package.json

# --ignore-scripts НЕ используется: postinstall Prisma скачивает движки,
# без них не работает ни generate, ни runtime.
RUN npm ci

# Схема — до остального кода: prisma generate зависит только от неё,
# и правка любого .ts-сервиса не должна инвалидировать этот слой.
COPY apps/api/prisma ./apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

COPY apps/api ./apps/api
COPY scripts ./scripts
COPY docker/entrypoint-api.sh /usr/local/bin/entrypoint-api.sh
RUN chmod +x /usr/local/bin/entrypoint-api.sh

WORKDIR /app/apps/api
EXPOSE 3000

# По умолчанию — dev-режим с watch. В compose исходники монтируются
# поверх /app/apps/api, поэтому правка на хосте перезапускает Nest
# внутри контейнера, а не требует пересборки образа.
CMD ["npm", "run", "start:dev"]
