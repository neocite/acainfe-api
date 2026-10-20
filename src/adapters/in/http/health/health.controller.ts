import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('health')
  async health() {
    await this.c.db.command({ ping: 1 });
    return { status: 'ok' };
  }
}
