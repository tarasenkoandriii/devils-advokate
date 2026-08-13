import { Module } from '@nestjs/common';
import { PhotoVerificationController } from './photo-verification.controller';
import { PhotoVerificationService } from './photo-verification.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule, ConsentModule],
  controllers: [PhotoVerificationController],
  providers: [PhotoVerificationService],
  exports: [PhotoVerificationService],
})
export class PhotoVerificationModule {}
