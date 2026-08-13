import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { WorkingMaterialsService } from './working-materials.service';

class SubmitVersionDto {
  extractedText!: string;
  materialId?: string;
  title?: string;
  engineId?: string;
}

@Controller('projects/:projectId/working-materials')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class WorkingMaterialsController {
  constructor(private readonly workingMaterials: WorkingMaterialsService) {}

  @Post()
  async submit(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SubmitVersionDto,
  ) {
    return this.workingMaterials.submitVersion(
      userId,
      projectId,
      dto.extractedText,
      dto.materialId,
      dto.title,
      dto.engineId,
    );
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.workingMaterials.listMaterials(userId, projectId);
  }

  @Get(':materialId')
  async get(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('materialId') materialId: string,
  ) {
    return this.workingMaterials.getMaterial(userId, projectId, materialId);
  }
}
