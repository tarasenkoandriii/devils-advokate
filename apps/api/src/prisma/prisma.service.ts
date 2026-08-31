// Стандартный NestJS-паттерн: PrismaClient как injectable-сервис с
// managed lifecycle (подключение при старте модуля, отключение при
// остановке приложения) — не создаётся заново в каждом сервисе.

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { diagnoseDatabaseUrl, diagnosePoolerMismatch } from './database-url-check';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private static readonly logger = new Logger(PrismaService.name);

  constructor() {
    super();

    // ПОВТОРНЫЙ АУДИТ 2026-08-31 — проверка строки подключения при
    // создании сервиса. Сама по себе она ничего не чинит и ничего не
    // блокирует: смысл в том, чтобы в логах вместо «invalid port number
    // in database URL» (симптом) стояла причина — кавычки вокруг
    // значения или незакодированный «@» в пароле. Разбор — в
    // database-url-check.ts.
    //
    // Не бросаем исключение: приложение должно подниматься и отдавать
    // /healthz даже с кривой строкой подключения, иначе диагностику
    // придётся вести по единственному «функция крашится».
    const problems = diagnoseDatabaseUrl(process.env.DATABASE_URL);
    for (const problem of problems) {
      PrismaService.logger.error(`DATABASE_URL: ${problem.message} [${problem.code}]`);
    }
    const poolerWarning = diagnosePoolerMismatch(process.env.DATABASE_URL);
    if (poolerWarning) {
      PrismaService.logger.warn(`DATABASE_URL: ${poolerWarning}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ПОЧЕМУ ЗДЕСЬ НЕТ onModuleInit С $connect()
  //
  // Он был, и на serverless это оказалось плохим решением: подключение
  // выполнялось на КАЖДОМ холодном старте, до маршрутизации, и любая
  // проблема с базой (недоступный хост, исчерпанный пул, неверный
  // DATABASE_URL, ограничение по IP) роняла функцию целиком —
  // FUNCTION_INVOCATION_FAILED на любом запросе, включая те, которым
  // база вообще не нужна. Наружу это выглядит как «всё сломалось», а не
  // как «база недоступна», и в логах видно только стек Prisma.
  //
  // Prisma подключается лениво при первом запросе — $connect() не
  // обязателен, он лишь переносит подключение на более ранний момент.
  // Для долгоживущего процесса это давало fail-fast и было осмысленно;
  // на serverless выгода исчезает (инстанс всё равно поднимется заново
  // на следующем запросе), а цена — лишние сотни миллисекунд к каждому
  // холодному старту и превращение «одна фича не работает» в «API
  // не отвечает вообще».
  //
  // Теперь ошибка базы приходит туда, где к базе обратились: конкретный
  // эндпоинт отдаёт ошибку через ApiExceptionFilter, остальные работают.
  // ══════════════════════════════════════════════════════════════════

  async onModuleDestroy(): Promise<void> {
    // Отключение оставлено: для локального процесса это корректное
    // завершение, на serverless вызывается редко (инстанс чаще просто
    // замораживается), но вреда не приносит.
    await this.$disconnect();
  }
}
