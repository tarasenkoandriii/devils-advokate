import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { StaleFactService } from './stale-fact.service';

// GET везде, не POST — детерминированная выборка по уже существующему
// полю, не AI-вызов, тот же принцип, что EvidenceGapController.
@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class StaleFactController {
  constructor(private readonly staleFact: StaleFactService) {}

  @Get('projects/:projectId/stale-facts')
  async listForProject(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.staleFact.listForProject(userId, projectId);
  }

  @Get('people/:personId/stale-facts')
  async listByPerson(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.staleFact.listByPerson(userId, personId);
  }
}
