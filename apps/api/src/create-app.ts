// Общая логика создания Nest-приложения — раньше жила только в main.ts.
// Вынесена сюда, потому что Vercel-деплой требует serverless-обёртку
// (api/index.ts), которая создаёт то же самое Nest-приложение поверх
// уже существующего Express-инстанса (ExpressAdapter), а не своего
// собственного HTTP-сервера через app.listen() — на serverless нет
// "слушающего порта", есть только функция-обработчик одного запроса.
// Дублировать бутстрап-логику (фильтр ошибок, CORS) в двух местах —
// гарантированный способ рассинхронизировать локальное поведение и
// продакшн, поэтому единая точка создания.

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication, ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';

export interface CreateAppOptions {
  /** Существующий Express-инстанс — обязателен для serverless
   * (api/index.ts на Vercel), не передаётся для локального запуска
   * (там Nest создаёт свой Express-сервер сам через app.listen()). */
  expressInstance?: import('express').Express;
}

export async function createNestApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const app = options.expressInstance
    ? await NestFactory.create<NestExpressApplication>(
        AppModule,
        new ExpressAdapter(options.expressInstance),
      )
    : await NestFactory.create<NestExpressApplication>(AppModule);

  // Единый формат ошибок { success: false, error } — см. api-exception.filter.ts.
  app.useGlobalFilters(new ApiExceptionFilter());

  // CORS — параметризован через переменную окружения, не открыт всем
  // подряд. TMA — веб-страница внутри Telegram WebView на собственном
  // Vercel-домене, не запрос напрямую из приложения Telegram — нужен
  // именно домен TMA в allowlist. CORS_ORIGIN — через запятую, если
  // доменов несколько (dev + prod).
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((s) => s.trim()) : true,
  });

  return app;
}
