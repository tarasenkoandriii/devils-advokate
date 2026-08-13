import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LibraryService } from './library.service';

class VoteDto {
  direction!: 'up' | 'down';
}

class AddExperienceDto {
  text!: string;
  authorDisplayName?: string;
}

// НАМЕРЕННО БЕЗ @UseGuards(TelegramAuthGuard) — второй (после
// public-discussion) публичный контроллер проекта. "Даёт SEO-трафик,
// вирусность и социальное доказательство" (§3.5 ТЗ, буквально) —
// сама цель фичи требует индексируемости поисковиками, что
// принципиально несовместимо с гейтом по Telegram-аутентификации.
@Controller('public/library')
@UseInterceptors(ApiResponseInterceptor)
export class LibraryPublicController {
  constructor(private readonly library: LibraryService) {}

  @Get()
  async browse(@Query('category') category?: string) {
    return this.library.browse(category);
  }

  @Get(':entryId')
  async getEntry(@Param('entryId') entryId: string) {
    return this.library.getEntry(entryId);
  }

  @Post(':entryId/vote')
  async vote(@Param('entryId') entryId: string, @Body() dto: VoteDto) {
    return this.library.vote(entryId, dto.direction);
  }

  @Post(':entryId/experiences')
  async addExperience(@Param('entryId') entryId: string, @Body() dto: AddExperienceDto) {
    return this.library.addExperience(entryId, dto.text, dto.authorDisplayName);
  }
}
