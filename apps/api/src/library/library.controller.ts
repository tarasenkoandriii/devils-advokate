import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
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
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3
  async submit(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SubmitProjectDto,
  ) {
    return this.library.submitProject(userId, projectId, dto.title, dto.category);
  }
}

// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.1) —
// вынесено в ОТДЕЛЬНЫЙ контроллер с AdminSessionGuard, не общий
// class-level guard на весь LibraryController. Буквальная формулировка
// ТЗ ("переключается... включая уже существующие library/venue-
// application controllers") при проверке оказалась неточной для этого
// файла — submit() выше остаётся действием обычного TMA-пользователя
// (любой пользователь публикует проект в библиотеку), не модератора;
// слепое переключение guard'а на весь контроллер сломало бы этот путь
// для всех обычных пользователей. LibraryService.assertModerator()
// внутри не меняется вообще (acceptance-тест §5.4) — единственная
// правка на уровне контроллера, не сервиса.
@Controller('library')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LibraryModerationController {
  constructor(private readonly library: LibraryService) {}

  @Get('moderation-queue')
  async listPending(@CurrentUser() userId: string) {
    return this.library.listPendingForModeration(userId);
  }

  @Patch(':entryId/moderate')
  async moderate(
    @CurrentUser() userId: string,
    @Param('entryId') entryId: string,
    @Body() dto: ModerateDto,
  ) {
    return this.library.moderate(userId, entryId, dto.decision);
  }
}
