import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller';
import { LibraryPublicController } from './library.public-controller';
import { LibraryService } from './library.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [LibraryController, LibraryPublicController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
