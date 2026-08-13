import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { VenueApplicationService } from './venue-application.service';

// НАМЕРЕННО БЕЗ @UseGuards(TelegramAuthGuard) — "публичная карточка"
// (буквально §3.23 ТЗ), тот же принцип, что публичная библиотека
// (Пункт 57): цель раздела — публичная витрина одобренных заведений.
@Controller('public/venues')
@UseInterceptors(ApiResponseInterceptor)
export class VenueApplicationPublicController {
  constructor(private readonly venueApplication: VenueApplicationService) {}

  @Get()
  async list() {
    return this.venueApplication.listApprovedVenues();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.venueApplication.getApprovedVenue(id);
  }
}
