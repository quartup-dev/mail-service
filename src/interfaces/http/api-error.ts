export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'HTTPS_REQUIRED',
  'TRANSPORT_NOT_ALLOWED',
  'FROM_DOMAIN_NOT_ALLOWED',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'SMTP_HOST_NOT_ALLOWED',
  'API_TRANSPORT_NOT_CONFIGURED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

// Error con respuesta HTTP conocida; el manejador de errores lo traduce al formato común
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
