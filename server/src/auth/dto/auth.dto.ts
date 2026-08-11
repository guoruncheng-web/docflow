import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'Alex Morgan', maxLength: 120 })
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'Acme Studio', description: 'Name of the workspace created for this user', maxLength: 120 })
  @IsNotEmpty()
  @MaxLength(120)
  organizationName!: string;

  @ApiProperty({ example: 'alex@acme.studio', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'a-strong-password', minLength: 8, maxLength: 72 })
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'demo@orbitcrm.app' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'demo1234' })
  @IsNotEmpty()
  @MaxLength(72)
  password!: string;
}

export class AuthenticatedUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() organizationId!: string;
  @ApiProperty() organizationName!: string;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'Bearer token to send as `Authorization: Bearer <token>`' })
  accessToken!: string;

  @ApiProperty({ type: AuthenticatedUserDto })
  user!: AuthenticatedUserDto;
}
