// Пункт [job-domain-v2] К-20 — модуль бота-приёмника.
import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { VacancyIntakeModule } from '../vacancy-intake/vacancy-intake.module';
import { TelegramBotController } from './telegram-bot.controller';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [SecretsModule, VacancyIntakeModule],
  controllers: [TelegramBotController],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}
