import { Module } from '@nestjs/common';
import { PromptRegistryController } from './prompt-registry.controller';
import { PromptRegistryService } from './prompt-registry.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AdminAuthModule, AuditLogModule],
  controllers: [PromptRegistryController],
  providers: [PromptRegistryService],
  exports: [PromptRegistryService],
})
export class PromptRegistryModule {}
