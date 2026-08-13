import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ArchetypePerspectiveService } from './archetype-perspective.service';
import { ArchetypeType } from '@prisma/client';

class GenerateArchetypePerspectiveDto {
  archetypeType!: ArchetypeType;
  customArchetypeDescription?: string;
  targetPersonId?: string;
  engineId?: string;
  focusOnOwnPositionWeaknesses?: boolean;
}

@Controller('projects/:projectId/archetype-perspectives')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ArchetypePerspectiveController {
  constructor(private readonly archetypePerspective: ArchetypePerspectiveService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateArchetypePerspectiveDto,
  ) {
    return this.archetypePerspective.generate(
      userId,
      projectId,
      dto.archetypeType,
      dto.customArchetypeDescription,
      dto.targetPersonId,
      dto.engineId,
      dto.focusOnOwnPositionWeaknesses ?? false,
    );
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.archetypePerspective.list(userId, projectId);
  }
}
