import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { INVOICE_TEMPLATE, INVOICE_TEMPLATE_KEY, INVOICE_TEMPLATE_VERSION } from './invoice.template';

/**
 * Templates live in code and are published into the database.
 *
 * Keeping the definition in the repository means a change to what gets
 * extracted, which fields must be confirmed, or what blocks approval arrives as
 * a reviewable diff that ships and rolls back with the code depending on it.
 * The database row exists so that a processing run can point at the exact
 * version it was judged by, forever, even after the code has moved on.
 *
 * Publishing is therefore create-if-absent and never update: a version already
 * used by a run is immutable, and changing behaviour means a new version.
 */
@Injectable()
export class TemplatesService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.publish();
  }

  async publish(): Promise<void> {
    await this.prisma.processingTemplate.upsert({
      where: { key_version: { key: INVOICE_TEMPLATE_KEY, version: INVOICE_TEMPLATE_VERSION } },
      create: {
        key: INVOICE_TEMPLATE.key,
        version: INVOICE_TEMPLATE.version,
        name: INVOICE_TEMPLATE.name,
        description: INVOICE_TEMPLATE.description,
        promptVersion: INVOICE_TEMPLATE.promptVersion,
        definition: {
          fieldPolicies: INVOICE_TEMPLATE.fieldPolicies,
          approvalPolicy: INVOICE_TEMPLATE.approvalPolicy,
          destination: INVOICE_TEMPLATE.destination,
          supportedCurrencies: INVOICE_TEMPLATE.supportedCurrencies,
        },
      },
      update: {},
    });
  }

  async invoice() {
    const template = await this.prisma.processingTemplate.findUnique({
      where: { key_version: { key: INVOICE_TEMPLATE_KEY, version: INVOICE_TEMPLATE_VERSION } },
    });

    if (!template) {
      // Reachable only if publishing failed at boot, and worth being blunt
      // about: processing without a template row would leave records that
      // cannot say what rules produced them.
      throw new NotFoundException('The invoice template has not been published to this database.');
    }

    return template;
  }

  async list() {
    const templates = await this.prisma.processingTemplate.findMany({ orderBy: [{ key: 'asc' }, { version: 'desc' }] });

    return templates.map((template) => ({
      key: template.key,
      version: template.version,
      name: template.name,
      description: template.description,
      promptVersion: template.promptVersion,
      fields: INVOICE_TEMPLATE.fieldPolicies,
    }));
  }
}
