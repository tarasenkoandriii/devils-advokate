// Стандартный NestJS-паттерн: PrismaClient как injectable-сервис с
// managed lifecycle (подключение при старте модуля, отключение при
// остановке приложения) — не создаётся заново в каждом сервисе.

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
