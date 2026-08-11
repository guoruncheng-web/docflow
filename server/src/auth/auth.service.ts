import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthResponseDto, AuthenticatedUserDto, LoginDto, RegisterDto } from './dto/auth.dto';
import type { JwtPayload } from './jwt.strategy';

const BCRYPT_ROUNDS = 10;

/** Failures allowed before the account starts backing off. */
const MAX_ATTEMPTS_BEFORE_LOCK = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Creates a workspace and its first user in one transaction. */
  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const email = dto.email.trim().toLowerCase();

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        passwordHash,
        organization: { create: { name: dto.organizationName.trim() } },
      },
      include: { organization: true },
    });

    return this.issueToken(user);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
      include: { organization: true },
    });

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new UnauthorizedException(`Too many failed attempts. Try again in ${seconds} seconds.`);
    }

    // Compare against a dummy hash when the user is missing so that a wrong
    // email and a wrong password take the same amount of time to reject, and an
    // attacker cannot use response timing to enumerate accounts.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const matches = await bcrypt.compare(dto.password, hash);

    if (!user || !matches) {
      if (user) {
        await this.recordFailedLogin(user.id, user.failedLogins);
      }

      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.failedLogins > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    return this.issueToken(user);
  }

  /**
   * Locks the account for a growing window once the attempts pass the
   * threshold: 1, 2, 4, 8 … minutes, capped at an hour. Backing off rather than
   * locking outright keeps a forgetful owner from being shut out for good while
   * still making an online guessing attack hopeless.
   */
  private async recordFailedLogin(userId: string, previousFailures: number): Promise<void> {
    const failures = previousFailures + 1;
    const overThreshold = failures - MAX_ATTEMPTS_BEFORE_LOCK;

    const lockedUntil =
      overThreshold >= 0
        ? new Date(Date.now() + Math.min(2 ** overThreshold, 60) * 60_000)
        : null;

    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLogins: failures, lockedUntil },
    });
  }

  /**
   * Resolves the principal against the database rather than trusting the token
   * alone. A token outlives the row it describes — a reaped demo workspace, a
   * deleted account — and the client needs to be told to sign in again instead
   * of being shown an empty dashboard.
   */
  async currentUser(userId: string): Promise<AuthenticatedUserDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });

    if (!user) {
      throw new UnauthorizedException('This session is no longer valid');
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
    };
  }

  /** Public so the demo module can hand a token to a freshly minted workspace. */
  async issueToken(user: {
    id: string;
    email: string;
    name: string;
    organizationId: string;
    organization: { name: string };
  }): Promise<AuthResponseDto> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      org: user.organizationId,
      orgName: user.organization.name,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        organizationId: user.organizationId,
        organizationName: user.organization.name,
      },
    };
  }
}
