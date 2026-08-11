import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { CurrentUser as CurrentUserType } from '../auth/jwt.strategy';
import { SYNC_FAULTS, type SyncFault } from '../integrations/mock-accounting.adapter';
import { RecordsService } from './records.service';

class UpdateFieldsDto {
  @IsObject()
  changes!: Record<string, unknown>;
}

class ResolveFindingDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resolution?: string;
}

class DecisionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class SyncDto {
  @IsOptional()
  @IsIn(SYNC_FAULTS.map((fault) => fault.value))
  fault?: SyncFault;
}

@ApiTags('records')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'A record with its fields, evidence, findings, approvals and deliveries' })
  get(@CurrentUser() user: CurrentUserType, @Param('id', ParseUUIDPipe) id: string) {
    return this.records.get(user.organizationId, id);
  }

  @Patch(':id/fields')
  @ApiOperation({
    summary: 'Correct fields, producing a new version',
    description: 'The previous version is kept, and any approval of it is invalidated.',
  })
  update(
    @CurrentUser() user: CurrentUserType,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFieldsDto,
  ) {
    return this.records.updateFields(user.organizationId, id, dto.changes, user.name);
  }

  @Post(':id/findings/:findingId/resolve')
  @ApiOperation({ summary: 'Acknowledge a warning, or override a blocker with a reason' })
  resolve(
    @CurrentUser() user: CurrentUserType,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() dto: ResolveFindingDto,
  ) {
    return this.records.resolveFinding(user.organizationId, id, findingId, dto.resolution ?? '', user.name);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve the record as it stands, naming the version approved' })
  approve(
    @CurrentUser() user: CurrentUserType,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.records.approve(user.organizationId, id, user.id, dto.note, user.name);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject the record, with a reason' })
  reject(
    @CurrentUser() user: CurrentUserType,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.records.reject(user.organizationId, id, user.id, dto.note ?? '', user.name);
  }

  @Post(':id/sync')
  @ApiOperation({
    summary: 'Deliver the approved version to the destination',
    description:
      'Bounded and idempotent. A fault can be injected to watch the recovery — including a request that succeeds remotely and loses its response.',
  })
  sync(@CurrentUser() user: CurrentUserType, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SyncDto) {
    return this.records.deliver(user.organizationId, id, dto.fault ?? 'none');
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Every recorded action for this record, read from the audit log' })
  timeline(@CurrentUser() user: CurrentUserType, @Param('id', ParseUUIDPipe) id: string) {
    return this.records.timeline(user.organizationId, id);
  }
}
