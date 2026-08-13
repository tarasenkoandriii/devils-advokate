import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PrecedentSearchService } from './precedent-search.service';

class FindPrecedentsDto {
  situationDescription!: string;
  engineId?: string;
}

@Controller('people/:personId/precedents')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PrecedentSearchController {
  constructor(private readonly precedentSearch: PrecedentSearchService) {}

  @Post()
  async findPrecedents(
    @CurrentUser() userId: string,
    @Param('personId') personId: string,
    @Body() dto: FindPrecedentsDto,
  ) {
    return this.precedentSearch.findPrecedents(userId, personId, dto.situationDescription, dto.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.precedentSearch.list(userId, personId);
  }
}
