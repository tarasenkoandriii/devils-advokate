import { Module } from '@nestjs/common';
import { VenueApplicationController } from './venue-application.controller';
import { VenueApplicationPublicController } from './venue-application.public-controller';
import { VenueApplicationService } from './venue-application.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule],
  controllers: [VenueApplicationController, VenueApplicationPublicController],
  providers: [VenueApplicationService],
  exports: [VenueApplicationService],
})
export class VenueApplicationModule {}
