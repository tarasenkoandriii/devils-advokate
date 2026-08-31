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
  // Пункт [admin-panel]: credentials: true добавлен при реализации
  // apps/admin — без этого браузер не отправит/не примет cookie
  // AdminSession в cross-origin fetch (apps/admin и apps/api — разные
  // Vercel-домены, тот же принцип, что уже применялся к TMA/landing).
  //
  // КРИТИЧЕСКАЯ НАХОДКА АУДИТА: origin: true (отражение ЛЮБОГО Origin)
  // было безопасно ДО этого пункта, потому что credentials не были
  // включены — отражённый origin без credentials не даёт читать ответ
  // с куками и не позволяет CSRF через cookie. С появлением
  // AdminSession и credentials: true та же настройка стала реальной
  // уязвимостью: ЛЮБОЙ сторонний сайт может выполнить credentialed
  // cross-site запрос к /admin/* эндпоинтам (например,
  // PATCH /admin/users/:id/restrict) от имени залогиненного оператора,
  // используя его браузер как посредника — классический CSRF, усиленный
  // тем, что отражённый origin вместе с credentials позволяет ещё и
  // прочитать сам ответ, не только вызвать побочный эффект вслепую.
  // Origin: '*' браузер в принципе отклоняет вместе с credentials —
  // именно поэтому исходная защита полагалась на "безопасное на вид"
  // отражение origin, не заметив, что отражение ЛЮБОГО origin
  // функционально эквивалентно '*' для целей CSRF.
  //
  // Исправлено: разрешённые origin'ы ДОЛЖНЫ быть явно перечислены в
  // production через CORS_ORIGIN — permissive fallback (отражение
  // любого origin) остаётся только для локальной разработки
  // (NODE_ENV !== 'production'), где нет реального стороннего сайта,
  // способного атаковать браузер разработчика тем же путём.
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !corsOrigin) {
    // eslint-disable-next-line no-console
    console.error(
      'CORS_ORIGIN is not set in production — cross-origin requests (including apps/admin) will be blocked. ' +
        'This is intentional: reflecting an arbitrary Origin together with credentials:true would be a CSRF/credential-leak vulnerability.',
    );
  }
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((s) => s.trim()) : !isProd,
    credentials: true,
  });

  return app;
}
