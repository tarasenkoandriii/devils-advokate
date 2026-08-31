import { Module } from '@nestjs/common';
import { LibraryController, LibraryModerationController } from './library.controller';
import { LibraryPublicController } from './library.public-controller';
import { LibraryService } from './library.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TelegramAuthModule, AdminAuthModule, AuditLogModule],
  controllers: [LibraryController, LibraryModerationController, LibraryPublicController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
