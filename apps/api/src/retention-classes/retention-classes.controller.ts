import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { RetentionClassService } from './retention-classes.service';

@Controller('retention-classes')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class RetentionClassController {
  constructor(private readonly retentionClasses: RetentionClassService) {}

  @Get()
  async list() {
    return this.retentionClasses.list();
  }
}
