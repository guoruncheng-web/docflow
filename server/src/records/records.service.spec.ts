import { ConflictException } from '@nestjs/common';
import { RecordsService } from './records.service';

describe('RecordsService approval boundary', () => {
  it('refuses to approve a version that is already approved', async () => {
    const prisma = {
      record: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'record-1',
          organizationId: 'org-1',
          approvedVersion: 3,
        }),
      },
      validationFinding: { findMany: jest.fn() },
    };
    const service = new RecordsService(prisma as never, null as never, null as never, null as never);

    await expect(service.approve('org-1', 'record-1', 'user-1', undefined, 'Alex Moore')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.validationFinding.findMany).not.toHaveBeenCalled();
  });
});
