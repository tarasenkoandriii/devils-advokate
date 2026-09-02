import { Module } from '@nestjs/common';
import { PrivacyCenterController } from './privacy-center.controller';
import { PrivacyCenterService } from './privacy-center.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ExternalArtifactsModule } from '../common/external-artifacts/external-artifacts.module';

@Module({
  // ExternalArtifactsModule — уборка того, что живёт вне БД (файлы,
  // задачи у STT-провайдера) при удалении аккаунта; тот же сервис
  // использует удаление проекта (аудит 2026-09-02, продолжение).
  imports: [TelegramAuthModule, AuditLogModule, SecretsModule, ExternalArtifactsModule],
  controllers: [PrivacyCenterController],
  providers: [PrivacyCenterService],
})
export class PrivacyCenterModule {}
