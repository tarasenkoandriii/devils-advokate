import { ConversationSourceType } from '@prisma/client';

export interface CreateConversationDto {
  sourceType: ConversationSourceType;
  occurredAt: string; // ISO datetime — §2 ТЗ: время самого разговора/файла, не время запроса
  durationSeconds?: number;
  rawFileRef?: string; // клиентская ссылка "открыть на устройстве", не URL для транскрибации
}
