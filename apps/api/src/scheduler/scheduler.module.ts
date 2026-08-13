import { Module } from '@nestjs/common';
import { SchedulerController, SchedulerDispatchController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { SparringModule } from '../sparring/sparring.module';

// Пункт 90 (§3.26 ТЗ) — SparringModule ради preGenerateSparringOpener(),
// вызываемого из dispatchDueReminders() в момент отправки напоминания
// о спарринге. SparringModule не импортирует SchedulerModule обратно
// — циклической зависимости нет.
@Module({
  imports: [TelegramAuthModule, SecretsModule, SparringModule],
  controllers: [SchedulerController, SchedulerDispatchController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
