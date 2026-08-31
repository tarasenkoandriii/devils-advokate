# Devil's Advocate — общий образ для трёх Next.js-приложений
# (apps/tma, apps/admin, apps/landing) в локальном докер-стенде.
#
# ОДИН Dockerfile на три приложения, а не три почти одинаковых: у них
# идентичный стек (Next 14 + React 18, никаких нативных зависимостей) и
# общий корневой package-lock.json — различие только в том, какая папка
# запускается и на каком порту. Три копии файла разъехались бы при
# первом же обновлении Node или Next, причём молча.
#
# Приложение выбирается build-arg'ом APP_DIR (см. docker-compose.dev.yml).
FROM node:22-bookworm-slim

WORKDIR /app

# Как и в api.Dockerfile — сначала манифесты всех воркспейсов (корневой
# lock описывает всё дерево, npm ci без любого из них не отработает),
# потом уже исходники конкретного приложения.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/tma/package.json ./apps/tma/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/landing/package.json ./apps/landing/package.json

# --ignore-scripts здесь ОСОЗНАННО: этим образам Prisma не нужна вообще
# (Next-приложения не ходят в БД напрямую, только в apps/api по HTTP), а
# postinstall @prisma/client из корневого дерева тянул бы движки на ~80 МБ
# в каждый из трёх образов. Единственный postinstall в дереве — как раз
# прismовский, ничего полезного здесь не теряется.
RUN npm ci --ignore-scripts

ARG APP_DIR
COPY apps/${APP_DIR} ./apps/${APP_DIR}

# ENV из ARG — CMD выполняется в рантайме, когда build-arg уже недоступен.
ENV APP_DIR=${APP_DIR}
WORKDIR /app

EXPOSE 3000

# next dev с --hostname 0.0.0.0: по умолчанию Next слушает localhost, что
# внутри контейнера означает «только сам контейнер» — порт был бы
# опубликован, но соединение с хоста обрывалось бы без внятной ошибки.
# Порт задаётся переменной PORT из compose (у каждого приложения свой).
CMD ["sh", "-c", "npm run dev --workspace=apps/${APP_DIR} -- --hostname 0.0.0.0 --port ${PORT:-3000}"]
