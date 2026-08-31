import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AdminDomainsService } from './admin-domains.service';
import { AdminDomainsController } from './admin-domains.controller';

@Module({
  imports: [AdminAuthModule, AuditLogModule],
  providers: [AdminDomainsService],
  controllers: [AdminDomainsController],
})
export class AdminDomainsModule {}
