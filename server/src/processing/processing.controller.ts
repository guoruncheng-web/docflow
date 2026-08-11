import { Controller, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { CurrentUser as CurrentUserType } from '../auth/jwt.strategy';
import { ProcessingService } from './processing.service';

@ApiTags('processing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ProcessingController {
  constructor(private readonly processing: ProcessingService) {}

  /**
   * Streams a processing run as server-sent events.
   *
   * Streamed rather than returned whole because the middle is the interesting
   * part: the pages being read, the fields arriving token by token, a rejected
   * response being re-asked. A JSON body that appears several seconds later
   * shows a spinner and then a result, and "it validated the output" becomes a
   * claim the visitor has to take on faith.
   */
  @Post('documents/:id/process')
  @ApiOperation({ summary: 'Read, extract and validate a document — server-sent events, not JSON' })
  async process(
    @CurrentUser() user: CurrentUserType,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Vercel's proxy buffers responses without this, which turns a stream
      // into one delivery at the end and defeats the entire point.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await this.processing.process(user.organizationId, id, {
        onStage: (stage, detail) => send('stage', { stage, ...detail }),
        onToken: (token) => send('token', { token }),
        onAttempt: (attempt) => send('attempt', attempt),
      });

      send('done', result);
    } catch (error) {
      // The failure goes down the stream rather than as a status code: the
      // response has already been committed as 200, and a visitor watching a
      // document be read deserves the reason it stopped.
      send('failed', { message: (error as Error).message });
    } finally {
      res.end();
    }
  }
}
