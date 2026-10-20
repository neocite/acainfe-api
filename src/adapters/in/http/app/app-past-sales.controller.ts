import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { PastSalesOps } from '../past-sales/past-sales.ops.js';
import { AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('app (onboarding)')
@UseGuards(AppUserGuard)
@Controller('v1/app/companies/:tenantId/past-sales')
export class AppPastSalesController {
  private readonly ops: PastSalesOps;
  constructor(@Inject(CONTAINER) private readonly c: Container) {
    this.ops = new PastSalesOps(c);
  }
  private tenant(user: User, tenantId: string) {
    return this.c.accounts.ownedTenant(user, tenantId);
  }

  @Post('scan')
  async scan(@CurrentUser() user: User, @Param('tenantId') id: string, @Body() body: unknown) {
    return this.ops.scan(await this.tenant(user, id), body);
  }
  @Get()
  async summary(@CurrentUser() user: User, @Param('tenantId') id: string) {
    return this.ops.summary(await this.tenant(user, id));
  }
  @Get('items')
  async list(
    @CurrentUser() user: User,
    @Param('tenantId') id: string,
    @Query() query: Record<string, string>
  ) {
    return this.ops.list(await this.tenant(user, id), query);
  }
  @Post('mark')
  async mark(@CurrentUser() user: User, @Param('tenantId') id: string, @Body() body: unknown) {
    return this.ops.mark(await this.tenant(user, id), body);
  }
  @Post('ignore')
  async ignore(@CurrentUser() user: User, @Param('tenantId') id: string, @Body() body: unknown) {
    return this.ops.ignore(await this.tenant(user, id), body);
  }
  @Post('issue')
  async issue(@CurrentUser() user: User, @Param('tenantId') id: string, @Body() body: unknown) {
    return this.ops.issue(await this.tenant(user, id), body);
  }
  @Get('reconcile')
  async reconcile(
    @CurrentUser() user: User,
    @Param('tenantId') id: string,
    @Query() query: Record<string, string>
  ) {
    return this.ops.reconcile(await this.tenant(user, id), query);
  }
  @Post('reconcile/apply')
  async applyReconciliation(
    @CurrentUser() user: User,
    @Param('tenantId') id: string,
    @Body() body: unknown
  ) {
    return this.ops.applyReconciliation(await this.tenant(user, id), body);
  }
}
