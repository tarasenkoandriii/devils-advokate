// Локальный запуск (npm run start:dev) — на Vercel этот файл не
// используется вообще, там точка входа api/index.ts (serverless
// обёртка) на уровне корня apps/api, за пределами src/. Оба используют
// одну и ту же createNestApp() — см. create-app.ts, чтобы CORS/фильтр
// ошибок не разъезжались между локальной разработкой и продакшном.
//
// ВНИМАНИЕ ПРИ НАСТРОЙКЕ VERCEL: этот файл НЕ импортирует @nestjs/*
// напрямую (NestFactory живёт в create-app.ts). Нативный Nest-пресет
// Vercel ищет entrypoint, который импортирует nestjs, не находит его
// здесь и падает на сборке:
//   "No entrypoint found which imports nestjs. Found possible entrypoint: src/main.ts"
// Лечится не правкой импортов, а корректным пресетом: framework должен
// быть "Other" (в репозитории зафиксировано как "framework": null в
// apps/api/vercel.json). Наша точка входа на Vercel — api/index.ts, а
// не этот файл, поэтому Nest-пресет здесь не нужен в принципе.

import { createNestApp } from './create-app';

async function bootstrap() {
  const app = await createNestApp();
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Devil's Advocate API listening on port ${port}`);
}

bootstrap();
