import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ClientBriefModule } from '../client-brief/client-brief.module';
import { EmployerHiringController, EngagementController, OfferExchangeController } from './employer-hiring.controller';
import { EmployerHiringService } from './employer-hiring.service';
import { EngagementService } from './engagement.service';
import { OfferExchangeService } from './offer-exchange.service';

@Module({
  imports: [TelegramAuthModule, AuditLogModule, ClientBriefModule],
  controllers: [EmployerHiringController, EngagementController, OfferExchangeController],
  providers: [EmployerHiringService, EngagementService, OfferExchangeService],
  exports: [EmployerHiringService, EngagementService, OfferExchangeService],
})
export class EmployerHiringModule {}
