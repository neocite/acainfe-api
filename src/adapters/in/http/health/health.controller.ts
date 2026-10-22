import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('health')
  @ApiOperation({ summary: 'Saúde do serviço (sem autenticação)' })
  async health() {
    await this.c.db.command({ ping: 1 });
    return { status: 'ok' };
  }
}
