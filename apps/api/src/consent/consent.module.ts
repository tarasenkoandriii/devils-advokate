import { Global, Module } from '@nestjs/common';
import { ConsentService } from './consent.service';
import { ConsentController } from './consent.controller';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Global()
@Module({
  imports: [TelegramAuthModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
