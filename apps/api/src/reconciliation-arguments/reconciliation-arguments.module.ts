import { Module } from '@nestjs/common';
import { ReconciliationArgumentsController } from './reconciliation-arguments.controller';
import { ReconciliationArgumentsService } from './reconciliation-arguments.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [ReconciliationArgumentsController],
  providers: [ReconciliationArgumentsService],
  exports: [ReconciliationArgumentsService],
})
export class ReconciliationArgumentsModule {}
