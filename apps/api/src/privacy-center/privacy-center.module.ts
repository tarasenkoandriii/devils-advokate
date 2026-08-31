import { Module } from '@nestjs/common';
import { PrivacyCenterController } from './privacy-center.controller';
import { PrivacyCenterService } from './privacy-center.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, AuditLogModule, SecretsModule],
  controllers: [PrivacyCenterController],
  providers: [PrivacyCenterService],
})
export class PrivacyCenterModule {}
