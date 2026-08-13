import { Body, Controller, Get, Param, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import {
  NegotiationBoundariesService,
  SaveNegotiationBoundariesInput,
} from './negotiation-boundaries.service';

@Controller('projects/:projectId/boundaries')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class NegotiationBoundariesController {
  constructor(private readonly boundariesService: NegotiationBoundariesService) {}

  @Get()
  async get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.boundariesService.get(userId, projectId);
  }

  @Put()
  async save(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SaveNegotiationBoundariesInput,
  ) {
    return this.boundariesService.save(userId, projectId, dto);
  }
}
