import { Module } from '@nestjs/common';
import { LiveSessionController } from './live-session.controller';
import { LiveSessionService } from './live-session.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { SttModule } from '../stt/stt.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule, ConsentModule, SttModule],
  controllers: [LiveSessionController],
  providers: [LiveSessionService],
  exports: [LiveSessionService],
})
export class LiveSessionModule {}
