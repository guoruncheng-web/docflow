import { Controller, ForbiddenException, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController, ApiOperation } from '@nestjs/swagger';
import { DemoService } from '../demo/demo.service';

/**
 * Work that runs on a schedule rather than in a request.
 *
 * Guarded by a shared secret rather than a session, because the caller is
 * Vercel Cron and there is nobody to sign in. It is excluded from the public
 * documentation for the same reason: an endpoint that deletes workspaces has
 * no business being discoverable, and CORS never reaches it.
 */
@ApiExcludeController()
@Controller('internal/jobs')
export class JobsController {
  constructor(
    private readonly config: ConfigService,
    private readonly demo: DemoService,
  ) {}

  // A GET because that is what Vercel Cron issues, and it carries
  // `Authorization: Bearer $CRON_SECRET` automatically when the variable is set.
  @Get('cleanup')
  @ApiOperation({ summary: 'Delete expired demo workspaces and their stored files' })
  async cleanup(@Headers('authorization') authorization?: string) {
    this.assertCron(authorization);
    return this.demo.reap();
  }

  private assertCron(authorization?: string): void {
    const secret = this.config.get<string>('CRON_SECRET');

    // Refusing when the secret is unset is deliberate: a misconfigured
    // deployment should not quietly expose a destructive endpoint to anyone
    // who guesses the path.
    if (!secret || authorization !== `Bearer ${secret}`) {
      throw new ForbiddenException('This endpoint is for scheduled jobs.');
    }
  }
}
