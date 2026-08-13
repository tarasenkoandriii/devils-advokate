import { Body, Controller, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { TextToSpeechService } from './text-to-speech.service';

class SynthesizeDto {
  text!: string;
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
