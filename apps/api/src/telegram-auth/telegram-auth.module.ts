import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramAuthGuard } from './telegram-auth.guard';

@Module({
  imports: [ConfigModule],
  providers: [TelegramAuthGuard],
  exports: [TelegramAuthGuard],
})
export class TelegramAuthModule {}
