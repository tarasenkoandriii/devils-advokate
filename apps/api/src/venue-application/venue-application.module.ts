import { Module } from '@nestjs/common';
import { VenueApplicationController, VenueApplicationModerationController } from './venue-application.controller';
import { VenueApplicationPublicController } from './venue-application.public-controller';
import { VenueApplicationService } from './venue-application.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule, AdminAuthModule, AuditLogModule],
  controllers: [VenueApplicationController, VenueApplicationModerationController, VenueApplicationPublicController],
  providers: [VenueApplicationService],
  exports: [VenueApplicationService],
})
export class VenueApplicationModule {}
