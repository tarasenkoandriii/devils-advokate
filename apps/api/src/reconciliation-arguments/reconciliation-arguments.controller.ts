import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ReconciliationArgumentsService } from './reconciliation-arguments.service';

class GenerateReconciliationArgumentsDto {
  engineId?: string;
}

@Controller('projects/:projectId/reconciliation-arguments')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ReconciliationArgumentsController {
  constructor(private readonly reconciliationArguments: ReconciliationArgumentsService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateReconciliationArgumentsDto,
  ) {
    return this.reconciliationArguments.generate(userId, projectId, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.reconciliationArguments.list(userId, projectId);
  }
}
