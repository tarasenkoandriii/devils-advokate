import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { StakeholderMapService } from './stakeholder-map.service';
import { StakeholderRole } from '@prisma/client';

class ConfirmRoleDto {
  role!: StakeholderRole;
}

class SuggestRolesDto {
  engineId?: string;
}

@Controller('projects/:projectId/stakeholder-map')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class StakeholderMapController {
  constructor(private readonly stakeholderMap: StakeholderMapService) {}

  @Post('suggest-roles')
  async suggestRoles(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SuggestRolesDto,
  ) {
    return this.stakeholderMap.suggestRoles(userId, projectId, dto?.engineId);
  }

  @Patch('people/:personId/role')
  async confirmRole(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() dto: ConfirmRoleDto,
  ) {
    return this.stakeholderMap.confirmRole(userId, projectId, personId, dto.role);
  }

  @Post('people/:personId/arguments')
  async generateArgumentsForStakeholder(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() dto: SuggestRolesDto,
  ) {
    return this.stakeholderMap.generateArgumentsForStakeholder(userId, projectId, personId, dto?.engineId);
  }

  @Get()
  async listByStakeholder(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.stakeholderMap.listByStakeholder(userId, projectId);
  }
}
