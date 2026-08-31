// Пункт [prompt-framework]: контролер поверх PromptRegistryService,
// devils-advocate-prompt-framework-tz.md §5.1.

import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PromptRegistryService } from './prompt-registry.service';

class CreateDraftDto {
  promptId!: string;
  version!: string;
  template!: string;
  changelog?: string;
}

class UpdateDraftDto {
  template?: string;
  changelog?: string;
}

@Controller('admin/prompts')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PromptRegistryController {
  constructor(private readonly promptRegistry: PromptRegistryService) {}

  @Post()
  async createDraft(@CurrentUser() userId: string, @Body() dto: CreateDraftDto) {
    return this.promptRegistry.createDraft(userId, dto.promptId, dto.version, dto.template, dto.changelog);
  }

  @Get(':promptId')
  async listVersions(@CurrentUser() userId: string, @Param('promptId') promptId: string) {
    return this.promptRegistry.listVersions(userId, promptId);
  }

  @Get(':promptId/active')
  async getActiveVersion(@CurrentUser() userId: string, @Param('promptId') promptId: string) {
    return this.promptRegistry.getActiveVersion(userId, promptId);
  }

  @Patch(':id')
  async updateDraft(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: UpdateDraftDto) {
    return this.promptRegistry.updateDraft(userId, id, dto);
  }

  @Post(':id/promote-to-testing')
  async promoteToTesting(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.promptRegistry.promoteToTesting(userId, id);
  }

  @Post(':id/promote-to-active')
  async promoteToActive(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.promptRegistry.promoteToActive(userId, id);
  }

  @Post(':promptId/rollback')
  async rollback(@CurrentUser() userId: string, @Param('promptId') promptId: string) {
    return this.promptRegistry.rollback(userId, promptId);
  }
}
