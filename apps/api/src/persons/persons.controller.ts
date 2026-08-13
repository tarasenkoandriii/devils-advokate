import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PersonsService } from './persons.service';
import { PersonStatus, StatusTrigger } from '@prisma/client';

class AddPersonDto {
  existingPersonId?: string;
  displayName?: string;
}

class UpdateStatusDto {
  status!: PersonStatus;
  trigger!: StatusTrigger;
  confirmed?: boolean;
}

@Controller('projects/:projectId/people')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PersonsController {
  constructor(private readonly persons: PersonsService) {}

  @Post()
  async addPerson(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AddPersonDto,
  ) {
    return this.persons.addPerson(userId, projectId, dto);
  }

  @Get()
  async listPeople(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.persons.listPeople(userId, projectId);
  }

  @Patch(':personId/status')
  async updateStatus(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.persons.updateStatus(userId, projectId, personId, dto);
  }

  @Delete(':personId')
  async removePerson(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
  ) {
    await this.persons.removePerson(userId, projectId, personId);
    return { removed: true };
  }
}
