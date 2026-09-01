// Пункт [validation] 2026-09-01 — закрывает класс инъекций из отчёта
// аудита: Express разбирает `?category[not]=x` в ОБЪЕКТ {not:'x'},
// а параметр объявлен как string и уходил прямо в Prisma-`where` —
// то есть любой посетитель публичного GET /library мог подставить
// произвольный Prisma-оператор (not/contains/gt/…) вместо значения.
//
// Один глобальный pipe вместо ручной проверки в 31 контроллерном
// параметре: для query/param-аргументов, ОБЪЯВЛЕННЫХ как string
// (metatype === String — string-enum'ы TS сюда же попадают),
// не-строковое значение — это всегда попытка smuggling'а структуры
// через строковый параметр, а не легитимный запрос → 400.
// DTO-объекты в @Query() (metatype-класс) не задеваются.

import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class StringQueryGuardPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (
      (metadata.type === 'query' || metadata.type === 'param') &&
      metadata.metatype === String &&
      value !== undefined &&
      typeof value !== 'string'
    ) {
      throw new BadRequestException(
        `Параметр "${metadata.data ?? ''}" должен быть строкой`,
      );
    }
    return value;
  }
}
