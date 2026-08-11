import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TemplatesService } from './templates.service';

@ApiTags('templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @ApiOperation({
    summary: 'The published processing templates',
    description:
      'A template is the whole definition of how one document type becomes a business record: fields, confidence thresholds, rules and destination mapping. Versions are immutable once used.',
  })
  list() {
    return this.templates.list();
  }
}
