import { Module } from '@nestjs/common';
import { CalibrationController, CalibrationDispatchController } from './calibration.controller';
import { CalibrationService } from './calibration.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [AdminAuthModule, SecretsModule],
  controllers: [CalibrationController, CalibrationDispatchController],
  providers: [CalibrationService],
  exports: [CalibrationService],
})
export class CalibrationModule {}
