import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LibraryService } from './library.service';

class SubmitProjectDto {
  title!: string;
  category!: string;
}

class ModerateDto {
  decision!: 'ACCEPT' | 'REJECT';
}

@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
@Controller()
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Post('projects/:projectId/submit-to-library')
  async submit(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SubmitProjectDto,
  ) {
    return this.library.submitProject(userId, projectId, dto.title, dto.category);
  }

  // Модерация — требует User.isLibraryModerator (проверяется внутри
  // сервиса, не отдельным guard'ом — тот же минимальный подход, что
  // задокументирован над полем в schema.prisma).
  @Get('library/moderation-queue')
  async listPending(@CurrentUser() userId: string) {
    return this.library.listPendingForModeration(userId);
  }

  @Patch('library/:entryId/moderate')
  async moderate(
    @CurrentUser() userId: string,
    @Param('entryId') entryId: string,
    @Body() dto: ModerateDto,
  ) {
    return this.library.moderate(userId, entryId, dto.decision);
  }
}
