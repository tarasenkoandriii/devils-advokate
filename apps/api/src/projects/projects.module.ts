import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ExternalArtifactsModule } from '../common/external-artifacts/external-artifacts.module';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  // ExternalArtifactsModule — уборка файлов и задач у STT-провайдера при
  // удалении проекта (аудит 2026-09-02, продолжение): каскад БД их не видит.
  imports: [TelegramAuthModule, ExternalArtifactsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
