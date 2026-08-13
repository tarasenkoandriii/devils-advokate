import { Module } from '@nestjs/common';
import { ArgumentsController } from './arguments.controller';
import { ArgumentGenerationService } from './argument-generation.service';
import { ArgumentLifecycleService } from './argument-lifecycle.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [ArgumentsController],
  providers: [ArgumentGenerationService, ArgumentLifecycleService],
})
export class ArgumentsModule {}
