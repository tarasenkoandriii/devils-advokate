import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { CommitmentsService, CreateCommitmentInput, UpdateCommitmentInput } from './commitments.service';

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class CommitmentsController {
  constructor(private readonly commitments: CommitmentsService) {}

  @Post('projects/:projectId/commitments')
  async create(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateCommitmentInput,
  ) {
    return this.commitments.create(userId, projectId, dto);
  }

  @Get('projects/:projectId/commitments')
  async listByProject(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.commitments.listByProject(userId, projectId);
  }

  // §3.49 ТЗ: "отображается в хронологии по фигуранту" — по personId,
  // не по projectId, см. обоснование в CommitmentsService.listByPerson().
  @Get('people/:personId/commitments')
  async listByPerson(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.commitments.listByPerson(userId, personId);
  }

  @Patch('commitments/:id')
  async update(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCommitmentInput,
  ) {
    return this.commitments.update(userId, id, dto);
  }
}
