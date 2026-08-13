import {
  Body,
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ArgumentGenerationService } from './argument-generation.service';
import { ArgumentLifecycleService } from './argument-lifecycle.service';
import { ArgumentLifecycleStatus } from '@prisma/client';

class GenerateArgumentsDto {
  engineId?: string;
}

class TransitionArgumentLifecycleDto {
  toStatus: ArgumentLifecycleStatus;
  conversationId?: string;
  note?: string;
}

@Controller('projects/:projectId/arguments')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ArgumentsController {
  constructor(
    private readonly generationService: ArgumentGenerationService,
    private readonly lifecycleService: ArgumentLifecycleService,
  ) {}

  @Post('generate')
  async generate(
    @Param('projectId') projectId: string,
    @CurrentUser() userId: string,
    @Body() dto: GenerateArgumentsDto,
  ) {
    return this.generationService.generate(projectId, userId, dto.engineId);
  }

  // Пункт 23 (§3.58 ТЗ) — projectId в URL не используется напрямую
  // (ownership проверяется через сам Argument → Project внутри
  // сервиса), оставлен для консистентности маршрута с остальными
  // эндпоинтами аргументов, не ради дополнительной проверки.
  @Post(':argumentId/lifecycle')
  async transitionLifecycle(
    @CurrentUser() userId: string,
    @Param('argumentId') argumentId: string,
    @Body() dto: TransitionArgumentLifecycleDto,
  ) {
    return this.lifecycleService.transition(userId, argumentId, dto.toStatus, {
      conversationId: dto.conversationId,
      note: dto.note,
    });
  }

  @Get(':argumentId/lifecycle')
  async getLifecycleHistory(@CurrentUser() userId: string, @Param('argumentId') argumentId: string) {
    return this.lifecycleService.getHistory(userId, argumentId);
  }

  @Get(':argumentId/lifecycle/insight')
  async getLifecycleInsight(@CurrentUser() userId: string, @Param('argumentId') argumentId: string) {
    return this.lifecycleService.getFailureInsight(userId, argumentId);
  }
}
