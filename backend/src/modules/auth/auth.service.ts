import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Database } from '../../db';
import { env } from '../../config/env';
import { RegisterInput, LoginInput } from './auth.validators';
import { AuthenticationError, ConflictError, NotFoundError } from '../../utils/errors';
import { AuditLogger } from '../../middleware/audit';

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static generateToken(userId: string, email: string): { token: string; expiresIn: number } {
    const token = jwt.sign(
      { sub: userId, email },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );
    return { token, expiresIn: env.JWT_EXPIRES_IN };
  }

  static async register(input: RegisterInput, requestId?: string) {
    const existingUser = await Database.query(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [input.email]
    );

    if (existingUser.rows.length > 0) {
      throw new ConflictError('ACCOUNT_UNAVAILABLE', 'An account with this email address cannot be registered.');
    }

    const passwordHash = await this.hashPassword(input.password);

    const insertResult = await Database.query(
      `INSERT INTO users (email, password_hash, display_name, account_status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id, email, display_name, account_status, email_verified_at, created_at`,
      [input.email, passwordHash, input.display_name]
    );

    const newUser = insertResult.rows[0];
    const { token, expiresIn } = this.generateToken(newUser.id, newUser.email);

    await AuditLogger.log({
      actorUserId: newUser.id,
      action: 'USER_REGISTERED',
      entityName: 'users',
      entityId: newUser.id,
      requestId,
      metadata: { email: newUser.email },
    });

    return {
      user: {
        id: newUser.id,
        email: newUser.email,
        display_name: newUser.display_name,
        account_status: newUser.account_status,
      },
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }

  static async login(input: LoginInput, requestId?: string) {
    const result = await Database.query(
      `SELECT id, email, password_hash, display_name, account_status
       FROM users
       WHERE lower(email) = lower($1)`,
      [input.email]
    );

    if (result.rows.length === 0) {
      throw new AuthenticationError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const user = result.rows[0];

    if (user.account_status !== 'ACTIVE') {
      throw new AuthenticationError('INVALID_CREDENTIALS', 'Account is disabled or pending verification.');
    }

    const passwordValid = await this.verifyPassword(input.password, user.password_hash);
    if (!passwordValid) {
      throw new AuthenticationError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    // Update last_login_at
    await Database.query(
      'UPDATE users SET last_login_at = now() WHERE id = $1',
      [user.id]
    );

    const { token, expiresIn } = this.generateToken(user.id, user.email);

    await AuditLogger.log({
      actorUserId: user.id,
      action: 'USER_LOGGED_IN',
      entityName: 'users',
      entityId: user.id,
      requestId,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        account_status: user.account_status,
      },
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }

  static async getProfile(userId: string) {
    const result = await Database.query(
      `SELECT id, email, display_name, account_status, email_verified_at, created_at
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('USER_NOT_FOUND', 'User profile not found.');
    }

    return result.rows[0];
  }
}
