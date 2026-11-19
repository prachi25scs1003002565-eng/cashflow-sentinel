export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: Array<{ field?: string; issue: string }> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Array<{ field?: string; issue: string }>
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Array<{ field?: string; issue: string }>) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(code = 'AUTHENTICATION_REQUIRED', message = 'Authentication required.') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = 'ROLE_REQUIRED', message = 'You do not have permission to perform this action.') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(code = 'RESOURCE_NOT_FOUND', message = 'Resource not found.') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(code = 'STATE_CONFLICT', message = 'Resource conflict or invalid state transition.') {
    super(409, code, message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Analytics simulation service is currently unavailable. Please try again later.') {
    super(503, 'SERVICE_UNAVAILABLE', message);
  }
}
