// Пункт [admin-panel]: контролер поверх AdminUsersService,
// devils-advocate-admin-panel-tz.md §4.3.

import { Body, Controller, Get, Param, Patch, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminUsersService } from './admin-users.service';

class RestrictUserDto {
  restricted!: boolean;
  note?: string;
}

class BlockUserDto {
  blocked!: boolean;
  note?: string;
}

@Controller('admin/users')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Query('search') search?: string,
    @Query('restricted') restricted?: string,
    @Query('blocked') blocked?: string,
  ) {
    const parsedRestricted = restricted === undefined ? undefined : restricted === 'true';
    const parsedBlocked = blocked === undefined ? undefined : blocked === 'true';
    return this.adminUsers.listUsers(userId, search, parsedRestricted, parsedBlocked);
  }

  @Get(':id')
  async detail(@CurrentUser() userId: string, @Param('id') targetUserId: string) {
    return this.adminUsers.getUserDetail(userId, targetUserId);
  }

  @Patch(':id/restrict')
  async restrict(
    @CurrentUser() userId: string,
    @Param('id') targetUserId: string,
    @Body() dto: RestrictUserDto,
  ) {
    return this.adminUsers.restrictUser(userId, targetUserId, dto.restricted, dto.note);
  }

  @Patch(':id/block')
  async block(
    @CurrentUser() userId: string,
    @Param('id') targetUserId: string,
    @Body() dto: BlockUserDto,
  ) {
    return this.adminUsers.blockUser(userId, targetUserId, dto.blocked, dto.note);
  }
}
