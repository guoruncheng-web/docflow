import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { CurrentUser as CurrentUserType } from '../auth/jwt.strategy';
import { DocumentsService } from './documents.service';
import { SamplesService } from './samples.service';

class FromSampleDto {
  @IsString()
  slug!: string;
}

class ProcessOptionsDto {
  @IsIn(['none', 'malformed_output', 'rate_limit'])
  fault!: string;
}

/** Uploads are capped here as well as in the service; the parser should not read 90 MB to find out it is too big. */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly samples: SamplesService,
  ) {}

  @Get('documents')
  @ApiOperation({ summary: 'The document queue, newest first' })
  list(@CurrentUser() user: CurrentUserType) {
    return this.documents.list(user.organizationId);
  }

  @Get('samples')
  @ApiOperation({
    summary: 'The synthetic invoices this demo ships with',
    description:
      'Each one is written to produce a specific outcome — a duplicate, an arithmetic error, an unbookable currency — so the demo can promise a failure and then produce it.',
  })
  gallery() {
    return this.samples.list();
  }

  @Post('documents/from-sample')
  @ApiOperation({ summary: 'Copy a sample invoice into this workspace' })
  async fromSample(@CurrentUser() user: CurrentUserType, @Body() dto: FromSampleDto) {
    const document = await this.documents.fromSample(user.organizationId, dto.slug);
    return { id: document.id, filename: document.filename, status: document.status };
  }

  @Post('documents/uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Upload a PDF into this workspace' })
  async upload(@CurrentUser() user: CurrentUserType, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file was attached to the request.');

    const document = await this.documents.fromUpload({
      organizationId: user.organizationId,
      filename: file.originalname,
      contentType: file.mimetype,
      bytes: new Uint8Array(file.buffer),
    });

    return { id: document.id, filename: document.filename, status: document.status };
  }

  @Get('documents/:id')
  @ApiOperation({ summary: 'One document with its pages and processing runs' })
  get(@CurrentUser() user: CurrentUserType, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(user.organizationId, id);
  }

  @Get('documents/:id/file')
  @ApiOperation({
    summary: 'A short-lived signed URL for the original file',
    description:
      'The store is private, so this is minted per request after the caller has been checked, and expires in five minutes.',
  })
  file(@CurrentUser() user: CurrentUserType, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.fileUrl(user.organizationId, id);
  }
}

export { ProcessOptionsDto };
