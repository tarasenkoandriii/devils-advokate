import { Module } from '@nestjs/common';
import { PersonFactsController } from './person-facts.controller';
import { PersonFactsService } from './person-facts.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [PersonFactsController],
  providers: [PersonFactsService],
  exports: [PersonFactsService],
})
export class PersonFactsModule {}
