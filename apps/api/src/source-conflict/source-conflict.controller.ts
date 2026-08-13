import { Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SourceConflictService } from './source-conflict.service';

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class SourceConflictController {
  constructor(private readonly sourceConflict: SourceConflictService) {}

  @Post('people/:personId/source-conflicts/detect')
  async detect(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.sourceConflict.detect(userId, personId);
  }

  @Get('people/:personId/source-conflicts')
  async list(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.sourceConflict.list(userId, personId);
  }

  @Patch('source-conflicts/:id/resolve')
  async markResolved(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sourceConflict.markResolved(userId, id);
  }
}
