// Точка входа для Vercel serverless (Node.js runtime, автоматически
// определяется по расположению в /api). Не используется для локальной
// разработки — там src/main.ts с обычным app.listen().
//
// Кэширование между вызовами (cachedAppPromise) — критично для
// serverless: без него каждый HTTP-запрос заново создавал бы весь
// Nest-модуль (DI-контейнер, все провайдеры), что на "тёплой" Lambda
// было бы абсурдно медленно и создавало бы новый PrismaClient на
// каждый запрос (реальная причина исчерпания connection pool на
// serverless + Postgres без пулера — см. README.md, раздел про
// DATABASE_URL). На "холодном" старте кэша ещё нет — это тот самый
// cold start, с которым ничего не поделать на serverless в принципе,
// только минимизировать (см. README про Vercel Hobby ограничения).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import { createNestApp } from '../src/create-app';

const server = express();
let cachedAppPromise: Promise<unknown> | null = null;

function ensureApp(): Promise<unknown> {
  if (!cachedAppPromise) {
    cachedAppPromise = createNestApp({ expressInstance: server }).then((app) => app.init());
  }
  return cachedAppPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await ensureApp();
  server(req as unknown as express.Request, res as unknown as express.Response);
}
