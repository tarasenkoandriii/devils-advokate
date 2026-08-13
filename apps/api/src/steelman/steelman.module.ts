import { Module } from '@nestjs/common';
import { SteelmanController } from './steelman.controller';
import { SteelmanService } from './steelman.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [SteelmanController],
  providers: [SteelmanService],
})
export class SteelmanModule {}
