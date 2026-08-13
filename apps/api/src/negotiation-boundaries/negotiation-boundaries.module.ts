import { Module } from '@nestjs/common';
import { NegotiationBoundariesController } from './negotiation-boundaries.controller';
import { NegotiationBoundariesService } from './negotiation-boundaries.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [NegotiationBoundariesController],
  providers: [NegotiationBoundariesService],
  exports: [NegotiationBoundariesService],
})
export class NegotiationBoundariesModule {}
