// Локальный запуск (npm run start:dev) — на Vercel этот файл не
// используется вообще, там точка входа api/index.ts (serverless
// обёртка) на уровне корня apps/api, за пределами src/. Оба используют
// одну и ту же createNestApp() — см. create-app.ts, чтобы CORS/фильтр
// ошибок не разъезжались между локальной разработкой и продакшном.

import { createNestApp } from './create-app';

async function bootstrap() {
  const app = await createNestApp();
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Devil's Advocate API listening on port ${port}`);
}

bootstrap();
