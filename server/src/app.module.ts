import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { DemoController } from './demo/demo.controller';
import { DemoService } from './demo/demo.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { SamplesService } from './documents/samples.service';
import { HealthController } from './health.controller';
import { JobsController } from './jobs/jobs.controller';
import { LlmService } from './llm/llm.service';
import { MockAccountingAdapter } from './integrations/mock-accounting.adapter';
import { SyncService } from './integrations/sync.service';
import { PrismaModule } from './prisma/prisma.module';
import { ProcessingController } from './processing/processing.controller';
import { ProcessingService } from './processing/processing.service';
import { RecordsController } from './records/records.controller';
import { RecordsService } from './records/records.service';
import { BlobService } from './storage/blob.service';
import { TemplatesController } from './templates/templates.controller';
import { TemplatesService } from './templates/templates.service';
import { UsageController } from './usage/usage.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule],
  controllers: [
    HealthController,
    DemoController,
    TemplatesController,
    DocumentsController,
    ProcessingController,
    RecordsController,
    UsageController,
    JobsController,
  ],
  providers: [
    DemoService,
    SamplesService,
    DocumentsService,
    TemplatesService,
    ProcessingService,
    RecordsService,
    BlobService,
    LlmService,
    MockAccountingAdapter,
    SyncService,
  ],
})
export class AppModule {}
