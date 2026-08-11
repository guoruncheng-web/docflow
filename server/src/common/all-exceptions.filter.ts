import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * Last line of defence for anything thrown outside a controller's own handling.
 *
 * Without it, a Prisma error escapes as a 500 whose body carries the failing
 * query, the model name and sometimes column values. That is a free schema map
 * for anyone poking at the API, and it is noise for a legitimate client. Every
 * unexpected failure is logged in full on the server and answered with a
 * generic message.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const { status, message } = this.translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${request.method} ${request.url}`, exception as Error);
    }

    response.status(status).json({
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private translate(exception: unknown): { status: number; message: string | string[] } {
    // Anything a controller or pipe raised deliberately already has a safe body.
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);

      return { status: exception.getStatus(), message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return { status: HttpStatus.CONFLICT, message: 'That value is already taken' };
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, message: 'Not found' };
        case 'P2003':
          return { status: HttpStatus.BAD_REQUEST, message: 'Referenced record does not exist' };
        default:
          // Deliberately vague: the code alone would tell a caller which
          // constraint they tripped and, by extension, the shape of the schema.
          return { status: HttpStatus.BAD_REQUEST, message: 'The request could not be completed' };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, message: 'The request could not be completed' };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Something went wrong' };
  }
}
