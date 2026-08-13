import { Module } from '@nestjs/common';
import { DecisionOutcomeController } from './decision-outcome.controller';
import { DecisionOutcomeService } from './decision-outcome.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [DecisionOutcomeController],
  providers: [DecisionOutcomeService],
  exports: [DecisionOutcomeService],
})
export class DecisionOutcomeModule {}
