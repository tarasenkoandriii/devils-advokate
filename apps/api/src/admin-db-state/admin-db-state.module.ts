import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminDbStateService } from './admin-db-state.service';
import { AdminDbStateController } from './admin-db-state.controller';

@Module({
  imports: [AdminAuthModule],
  providers: [AdminDbStateService],
  controllers: [AdminDbStateController],
})
export class AdminDbStateModule {}
