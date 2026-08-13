import { Module } from '@nestjs/common';
import { RetentionClassController } from './retention-classes.controller';
import { RetentionClassService } from './retention-classes.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [RetentionClassController],
  providers: [RetentionClassService],
})
export class RetentionClassModule {}
