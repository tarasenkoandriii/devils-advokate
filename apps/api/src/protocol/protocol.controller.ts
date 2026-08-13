import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProtocolService } from './protocol.service';

class GenerateProtocolDto {
  engineId?: string;
}

@Controller('projects/:projectId/protocols')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ProtocolController {
  constructor(private readonly protocol: ProtocolService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateProtocolDto,
  ) {
    return this.protocol.generate(userId, projectId, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.protocol.list(userId, projectId);
  }
}
