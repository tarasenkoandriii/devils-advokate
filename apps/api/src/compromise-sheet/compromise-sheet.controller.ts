import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { CompromiseSheetService } from './compromise-sheet.service';
import { CompromiseSheetPhase } from '@prisma/client';

class GenerateSheetDto {
  phase!: CompromiseSheetPhase;
  engineId?: string;
}

class VoiceOverDto {
  voiceId?: string;
}

class SubmitUserVoiceDto {
  audioBase64!: string;
  normalizeVolume!: boolean;
  removePauses!: boolean;
  removeNoise!: boolean;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class CompromiseSheetController {
  constructor(private readonly compromiseSheet: CompromiseSheetService) {}

  @Post('sparring-sessions/:sessionId/compromise-sheets')
  async generate(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: GenerateSheetDto,
  ) {
    return this.compromiseSheet.generate(userId, sessionId, dto.phase, dto?.engineId);
  }

  @Get('sparring-sessions/:sessionId/compromise-sheets')
  async list(@CurrentUser() userId: string, @Param('sessionId') sessionId: string) {
    return this.compromiseSheet.listForSession(userId, sessionId);
  }

  @Get('compromise-sheets/:sheetId')
  async get(@CurrentUser() userId: string, @Param('sheetId') sheetId: string) {
    return this.compromiseSheet.getSheet(userId, sheetId);
  }

  @Post('compromise-sheets/:sheetId/voice-over')
  async generateVoiceOver(
    @CurrentUser() userId: string,
    @Param('sheetId') sheetId: string,
    @Body() dto: VoiceOverDto,
  ) {
    return this.compromiseSheet.generateVoiceOver(userId, sheetId, dto?.voiceId);
  }

  // Пункт 71 — уже обработанная на клиенте запись собственного голоса.
  @Post('compromise-sheets/:sheetId/user-voice')
  async submitUserVoice(
    @CurrentUser() userId: string,
    @Param('sheetId') sheetId: string,
    @Body() dto: SubmitUserVoiceDto,
  ) {
    return this.compromiseSheet.submitUserVoiceRecording(userId, sheetId, dto.audioBase64, {
      normalizeVolume: dto.normalizeVolume,
      removePauses: dto.removePauses,
      removeNoise: dto.removeNoise,
    });
  }

  @Patch('compromise-sheets/:sheetId/preview')
  async markPreviewed(@CurrentUser() userId: string, @Param('sheetId') sheetId: string) {
    return this.compromiseSheet.markPreviewed(userId, sheetId);
  }

  @Patch('compromise-sheets/:sheetId/sent')
  async markSentToFigurant(@CurrentUser() userId: string, @Param('sheetId') sheetId: string) {
    return this.compromiseSheet.markSentToFigurant(userId, sheetId);
  }
}
