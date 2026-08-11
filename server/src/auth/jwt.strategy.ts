import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/** Shape of the signed JWT payload. */
export interface JwtPayload {
  sub: string;
  email: string;
  org: string;
  orgName: string;
  name: string;
}

/**
 * The authenticated principal attached to every request. `organizationId` comes
 * from the signed token, never from a client-supplied header, which is what
 * makes the tenant boundary trustworthy.
 */
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): CurrentUser {
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      organizationId: payload.org,
      organizationName: payload.orgName,
    };
  }
}
