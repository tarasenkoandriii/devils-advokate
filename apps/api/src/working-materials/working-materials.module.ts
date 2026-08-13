import { Module } from '@nestjs/common';
import { WorkingMaterialsController } from './working-materials.controller';
import { WorkingMaterialsService } from './working-materials.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [WorkingMaterialsController],
  providers: [WorkingMaterialsService],
  exports: [WorkingMaterialsService],
})
export class WorkingMaterialsModule {}
