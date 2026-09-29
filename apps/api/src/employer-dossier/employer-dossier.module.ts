import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployerDossierController } from './employer-dossier.controller';
import { EmployerDossierService } from './employer-dossier.service';

@Module({
  imports: [TelegramAuthModule, AuditLogModule],
  controllers: [EmployerDossierController],
  providers: [EmployerDossierService],
  exports: [EmployerDossierService],
})
export class EmployerDossierModule {}
