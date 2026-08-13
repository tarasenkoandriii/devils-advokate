import { Module } from '@nestjs/common';
import { DecisionObjectiveController } from './decision-objective.controller';
import { DecisionObjectiveService } from './decision-objective.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [DecisionObjectiveController],
  providers: [DecisionObjectiveService],
  exports: [DecisionObjectiveService],
})
export class DecisionObjectiveModule {}
