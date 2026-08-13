import { Module } from '@nestjs/common';
import { ProjectLogController } from './project-log.controller';
import { ProjectLogService } from './project-log.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [ProjectLogController],
  providers: [ProjectLogService],
  exports: [ProjectLogService],
})
export class ProjectLogModule {}
