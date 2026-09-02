// Аудит 2026-09-02 (продолжение) — см. external-artifacts-cleanup.service.ts.
// Отдельный модуль, а не провайдер внутри ConversationsModule: его
// импортируют и PrivacyCenterModule, и ProjectsModule, а зависимости —
// AudioBlobService (ConversationsModule) и SttService (SttModule).
import { Module } from '@nestjs/common';
import { SecretsModule } from '../../secrets/secrets.module';
import { ConversationsModule } from '../../conversations/conversations.module';
import { SttModule } from '../../stt/stt.module';
import { ExternalArtifactsCleanupService } from './external-artifacts-cleanup.service';

@Module({
  imports: [SecretsModule, ConversationsModule, SttModule],
  providers: [ExternalArtifactsCleanupService],
  exports: [ExternalArtifactsCleanupService],
})
export class ExternalArtifactsModule {}
