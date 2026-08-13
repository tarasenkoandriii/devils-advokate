import { Module } from '@nestjs/common';
import { BootstrapController } from './bootstrap.controller';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [BootstrapController],
})
export class BootstrapModule {}
