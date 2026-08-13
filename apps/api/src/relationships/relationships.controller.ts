import { Body, Controller, Delete, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { RelationshipsService } from './relationships.service';
import { FactSourceType, RelationshipDirection, RelationshipType } from '@prisma/client';

class CreateRelationshipDto {
  personAId!: string;
  personBId!: string;
  type!: RelationshipType;
  label!: string;
  direction!: RelationshipDirection;
  strength?: number;
  sourceType!: FactSourceType;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class RelationshipsController {
  constructor(private readonly relationships: RelationshipsService) {}

  @Post('relationships')
  async create(@CurrentUser() userId: string, @Body() dto: CreateRelationshipDto) {
    return this.relationships.create(userId, dto);
  }

  @Get('people/:personId/relationships')
  async listForPerson(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.relationships.listForPerson(userId, personId);
  }

  @Delete('relationships/:relationshipId')
  async delete(@CurrentUser() userId: string, @Param('relationshipId') relationshipId: string) {
    return this.relationships.delete(userId, relationshipId);
  }

  // Пункт 43 — подсказки по совместному участию в разговоре, чистый
  // DB-запрос, не AI-вызов.
  @Get('relationships/suggestions')
  async suggestFromCoParticipation(@CurrentUser() userId: string) {
    return this.relationships.suggestFromCoParticipation(userId);
  }
}
