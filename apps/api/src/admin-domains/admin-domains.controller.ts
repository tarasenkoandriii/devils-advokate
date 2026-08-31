import { Body, Controller, Get, Param, Patch, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminDomainsService } from './admin-domains.service';

class FreezeDto {
  frozen!: boolean;
  note?: string;
}

@Controller('admin')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AdminDomainsController {
  constructor(private readonly service: AdminDomainsService) {}

  @Get('domains/summary')
  summary(@CurrentUser() userId: string) {
    return this.service.summary(userId);
  }

  @Get('domains/:domain/projects')
  list(@CurrentUser() userId: string, @Param('domain') domain: string, @Query('take') take?: string, @Query('skip') skip?: string, @Query('withConfig') withConfig?: string) {
    return this.service.listProjects(userId, domain, {
      take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined,
      withConfig: withConfig === undefined ? undefined : withConfig === 'true',
    });
  }

  @Get('domains/:domain/projects/:id')
  detail(@CurrentUser() userId: string, @Param('domain') domain: string, @Param('id') id: string) {
    return this.service.getProject(userId, domain, id);
  }

  @Patch('domains/:domain/projects/:id/freeze')
  freeze(@CurrentUser() userId: string, @Param('domain') domain: string, @Param('id') id: string, @Body() dto: FreezeDto) {
    return this.service.setFrozen(userId, domain, id, dto.frozen, dto.note);
  }

  @Get('intake/summary')
  intake(@CurrentUser() userId: string) {
    return this.service.intakeSummary(userId);
  }

  @Get('media-review/queues')
  mediaReview(@CurrentUser() userId: string) {
    return this.service.mediaReviewQueues(userId);
  }
}
