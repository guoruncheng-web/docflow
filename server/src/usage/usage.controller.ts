import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { CurrentUser as CurrentUserType } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { MockAccountingAdapter, SYNC_FAULTS } from '../integrations/mock-accounting.adapter';

@ApiTags('usage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class UsageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly destination: MockAccountingAdapter,
  ) {}

  /**
   * What this workspace has spent and where it went.
   *
   * Summed from the individual calls rather than estimated from an average,
   * and failed calls are included: a cost panel that only counts successes is
   * describing a bill nobody receives.
   */
  @Get('usage')
  @ApiOperation({ summary: 'Model spend, documents processed and delivery outcomes' })
  async usage(@CurrentUser() user: CurrentUserType) {
    const [calls, documents, records, jobs] = await Promise.all([
      this.prisma.modelCall.findMany({
        where: { organizationId: user.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.document.count({ where: { organizationId: user.organizationId } }),
      this.prisma.record.groupBy({
        by: ['status'],
        where: { organizationId: user.organizationId },
        _count: true,
      }),
      this.prisma.syncJob.findMany({
        where: { organizationId: user.organizationId },
        select: { status: true, attempts: true },
      }),
    ]);

    return {
      documents,
      recordsByStatus: Object.fromEntries(records.map((row) => [row.status, row._count])),
      calls: calls.length,
      spentMicros: calls.reduce((total, call) => total + call.costMicros, 0),
      inputTokens: calls.reduce((total, call) => total + call.inputTokens, 0),
      outputTokens: calls.reduce((total, call) => total + call.outputTokens, 0),
      deliveries: {
        total: jobs.length,
        synced: jobs.filter((job) => job.status === 'synced').length,
        failed: jobs.filter((job) => job.status === 'failed').length,
        // Attempts beyond the first are retries, and they are the number that
        // says whether the integration is healthy.
        retries: jobs.reduce((total, job) => total + Math.max(0, job.attempts - 1), 0),
      },
      recent: calls.slice(0, 12).map((call) => ({
        purpose: call.purpose,
        outcome: call.outcome,
        model: call.model,
        promptVersion: call.promptVersion,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costMicros: call.costMicros,
        latencyMs: call.latencyMs,
        at: call.createdAt.toISOString(),
      })),
    };
  }

  @Get('destination/bills')
  @ApiOperation({
    summary: "What the destination system believes it holds",
    description: 'The other side of the boundary, so a duplicate delivery can be checked rather than described.',
  })
  bills(@CurrentUser() user: CurrentUserType) {
    return this.destination.listBills(user.organizationId);
  }

  @Get('destination/faults')
  @ApiOperation({ summary: 'The failures that can be injected into a delivery' })
  faults() {
    return SYNC_FAULTS;
  }
}
