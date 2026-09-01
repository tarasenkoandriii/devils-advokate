import { Body, Controller, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { TextToSpeechService } from './text-to-speech.service';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SynthesizeDto {
  // Пункт [validation] 2026-09-01: ElevenLabs тарифицируется
  // посимвольно — безлимитный text был прямой дырой в бюджет.
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  voiceId?: string;
}

@Controller('tts')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class TextToSpeechController {
  constructor(private readonly tts: TextToSpeechService) {}

  @Post()
  async synthesize(@CurrentUser() userId: string, @Body() dto: SynthesizeDto) {
    return this.tts.synthesize(userId, dto.text, dto.voiceId);
  }
}
