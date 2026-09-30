import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength , IsNotEmpty} from 'class-validator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LibraryService } from './library.service';

// Пункт [outside-input] 2026-09-04 — те же декораторы и по тому же
// основанию, что в public-discussion: это маршрут записи без
// аутентификации. Проверка `direction` внутри самого сервиса при этом
// ОСТАЁТСЯ: сервис вызывается не только отсюда, и «проверили на входе»
// не отменяет «не доверяй аргументу».
export class LibraryVoteDto {
  @IsIn(['up', 'down']) direction!: 'up' | 'down';
}

export class AddExperienceDto {
  @IsString() @MinLength(1) @MaxLength(4000) text!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) authorDisplayName?: string;
}

// НАМЕРЕННО БЕЗ @UseGuards(TelegramAuthGuard) — один из трёх публичных
// контроллеров проекта (полный список с причинами —
// common/public-surfaces.ts). "Даёт SEO-трафик,
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
  async vote(@Param('entryId') entryId: string, @Body() dto: LibraryVoteDto) {
    return this.library.vote(entryId, dto.direction);
  }

  @Post(':entryId/experiences')
  async addExperience(@Param('entryId') entryId: string, @Body() dto: AddExperienceDto) {
    return this.library.addExperience(entryId, dto.text, dto.authorDisplayName);
  }
}
