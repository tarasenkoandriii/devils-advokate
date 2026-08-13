import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PersonFactsService, CreatePersonFactInput } from './person-facts.service';

@Controller('people/:personId/facts')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PersonFactsController {
  constructor(private readonly personFacts: PersonFactsService) {}

  @Post()
  async create(
    @CurrentUser() userId: string,
    @Param('personId') personId: string,
    @Body() dto: CreatePersonFactInput,
  ) {
    return this.personFacts.create(userId, personId, dto);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.personFacts.listForPerson(userId, personId);
  }
}
