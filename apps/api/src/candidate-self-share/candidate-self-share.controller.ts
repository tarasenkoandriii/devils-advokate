// Пункт [job-domain-v2] К-8 — самошеринг соискателя: создание/отзыв в
// job-search, публичное превью и приём — в candidate-shares.
import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { CandidateSelfShareService, ShareEdge } from './candidate-self-share.service';

class CreateSelfShareDto {
  @IsString() cvVariantId!: string;
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) visibleClauseIds!: string[];
  @IsIn(['to_agency', 'to_employer']) edge!: ShareEdge;
  @IsOptional() @IsString() consentVersion?: string | null;
  @IsOptional() @IsString() expiresAt?: string | null;
}
class AcceptSelfShareDto {
  @IsString() @MinLength(8) token!: string;
  @IsString() projectId!: string;
}

@Controller('job-search')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class CandidateSelfShareController {
  constructor(private readonly shares: CandidateSelfShareService) {}

  @Get('self-share/consent-text')
  consentText() {
    return this.shares.consentText();
  }

  @Post('terms-sheets/:id/self-share')
  create(@CurrentUser() userId: string, @Param('id') sheetId: string, @Body() dto: CreateSelfShareDto) {
    return this.shares.create(userId, sheetId, dto);
  }

  @Get('terms-sheets/:id/self-shares')
  list(@CurrentUser() userId: string, @Param('id') sheetId: string) {
    return this.shares.listMine(userId, sheetId);
  }

  @Post('self-shares/:id/revoke')
  revoke(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.shares.revoke(userId, id);
  }
}

@Controller('candidate-shares')
@UseInterceptors(ApiResponseInterceptor)
export class CandidateSelfSharePublicController {
  constructor(private readonly shares: CandidateSelfShareService) {}

  @Get('self/:token/preview')
  preview(@Param('token') token: string) {
    return this.shares.preview(token);
  }

  @Post('accept')
  @UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
  accept(@CurrentUser() userId: string, @Body() dto: AcceptSelfShareDto) {
    return this.shares.accept(userId, dto);
  }
}
