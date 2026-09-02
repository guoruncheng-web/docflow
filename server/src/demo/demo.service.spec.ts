import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DemoService } from './demo.service';

/**
 * A tenant is deleted whole. Every table that hangs off one must therefore
 * cascade, and the one that did not — an approval pointing at its approver —
 * made the workspaces people had actually used the ones that could not be
 * removed, then failed provisioning for everybody who came afterwards.
 *
 * The rule is read out of the migrations rather than out of the Prisma schema,
 * because the database enforces the migrations and nothing else.
 */
describe('tenant-owned foreign keys', () => {
  /** Seeded from code and never deleted, so nothing below may cascade from it. */
  const NOT_TENANT_OWNED = new Set(['processing_templates']);

  const effectiveRules = (): Map<string, { table: string; parent: string; onDelete: string }> => {
    const root = join(__dirname, '..', '..', 'prisma', 'migrations');
    const rules = new Map<string, { table: string; parent: string; onDelete: string }>();

    for (const dir of readdirSync(root).filter((entry) => /^\d/.test(entry)).sort()) {
      const sql = readFileSync(join(root, dir, 'migration.sql'), 'utf8');

      for (const [, table, name] of sql.matchAll(/ALTER TABLE "(\w+)" DROP CONSTRAINT "(\w+)"/g)) {
        void table;
        rules.delete(name);
      }

      const add =
        /ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"\s+FOREIGN KEY \("[\w"\s,]+"\) REFERENCES "(\w+)"\([^)]*\)\s+ON DELETE (\w+)/g;
      for (const [, table, name, parent, onDelete] of sql.matchAll(add)) {
        rules.set(name, { table, parent, onDelete });
      }
    }

    return rules;
  };

  it('reads every foreign key out of the migrations', () => {
    expect(effectiveRules().size).toBeGreaterThan(10);
  });

  it('cascades from every parent a tenant owns', () => {
    const offenders = [...effectiveRules().entries()]
      .filter(([, rule]) => !NOT_TENANT_OWNED.has(rule.parent) && rule.onDelete !== 'CASCADE')
      .map(([name, rule]) => `${name} (${rule.table} -> ${rule.parent}: ON DELETE ${rule.onDelete})`);

    expect(offenders).toEqual([]);
  });
});

describe('DemoService.createSandbox', () => {
  const organization = { id: 'org-1', name: 'Riverbend Operations' };
  const user = { id: 'user-1', organizationId: organization.id, organization };

  const build = (reapError?: Error) => {
    const prisma = {
      organization: {
        findMany: jest.fn().mockResolvedValue(reapError ? [{ id: 'stuck', documents: [] }] : []),
        delete: jest.fn().mockImplementation(() => (reapError ? Promise.reject(reapError) : Promise.resolve())),
        count: jest.fn().mockResolvedValue(1),
      },
      user: { create: jest.fn().mockResolvedValue(user) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const auth = { issueToken: jest.fn().mockResolvedValue({ accessToken: 'token', user }) };
    const blob = { remove: jest.fn().mockResolvedValue(undefined) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new DemoService(prisma as any, auth as any, blob as any);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    return { service, prisma, auth };
  };

  it('mints a workspace and signs the visitor in', async () => {
    const { service, auth } = build();

    await expect(service.createSandbox()).resolves.toEqual({ accessToken: 'token', user });
    expect(auth.issueToken).toHaveBeenCalledWith(user);
  });

  it('still provisions when a workspace cannot be reaped', async () => {
    const { service, auth } = build(new Error('foreign key constraint failed'));

    await expect(service.createSandbox()).resolves.toEqual({ accessToken: 'token', user });
    expect(auth.issueToken).toHaveBeenCalledWith(user);
  });

  it('keeps reaping the rest when one workspace refuses to go', async () => {
    const stuck = new Error('foreign key constraint failed');
    const { service, prisma } = build(stuck);
    prisma.organization.findMany.mockResolvedValue([
      { id: 'stuck', documents: [] },
      { id: 'fine', documents: [] },
    ]);
    prisma.organization.delete
      .mockRejectedValueOnce(stuck)
      .mockResolvedValueOnce(undefined);

    await expect(service.reap()).resolves.toEqual({ organizations: 1, blobs: 0 });
    expect(prisma.organization.delete).toHaveBeenCalledTimes(2);
  });
});
