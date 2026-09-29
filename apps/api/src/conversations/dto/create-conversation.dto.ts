import { ConversationSourceType } from '@prisma/client';
import { IsEnum, IsISO8601, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class CreateConversationDto {
  @IsEnum(ConversationSourceType) sourceType!: ConversationSourceType;
  // ISO datetime — §2 ТЗ: время самого разговора/файла, не время запроса
  @IsISO8601() occurredAt!: string;
  // Сутки с запасом: разговор длиннее суток — это не разговор, а ошибка
  // ввода, и принимать её молча значит считать по ней статистику.
  @IsOptional() @IsInt() @Min(0) @Max(86_400) durationSeconds?: number;
  // клиентская ссылка "открыть на устройстве", не URL для транскрибации
  @IsOptional() @IsString() @MaxLength(2000) rawFileRef?: string;
}
