import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SteelmanService } from './steelman.service';

class GenerateSteelmanDto {
  engineId?: string;
}

@Controller('projects/:projectId/people/:personId/steelman')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class SteelmanController {
  constructor(private readonly steelman: SteelmanService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() dto: GenerateSteelmanDto,
  ) {
    return this.steelman.generate(projectId, personId, userId, dto.engineId);
  }

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
  ) {
    return this.steelman.list(userId, projectId, personId);
  }
}
