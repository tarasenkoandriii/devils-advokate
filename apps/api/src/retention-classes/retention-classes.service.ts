// TTL-настройки — §4.7 ТЗ. Честно про объём: это read-эндпоинт над
// глобальным справочником политик, не enforcement. Реального удаления
// по истечении срока здесь нет — см. подробный комментарий в
// schema.prisma над моделью RetentionClass.
//
// Не требует userId для фильтрации — это не персональные данные
// пользователя, а глобальная декларация политики продукта, одинаковая
// для всех. TelegramAuthGuard всё равно применяется на уровне
// контроллера (не хотим отдавать даже эту информацию неаутентифицированным
// запросам), но сам список не зависит от того, какой именно пользователь
// его запросил.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RetentionClassService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.retentionClass.findMany({
      orderBy: { classKey: 'asc' },
    });
  }
}
