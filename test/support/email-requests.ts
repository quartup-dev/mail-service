import type { EmailRequest } from '../../src/domain/email';

export function apiRequest(overrides: Partial<EmailRequest> = {}): EmailRequest {
  return {
    transport: { type: 'api' },
    from: { email: 'notificaciones@example.com', name: 'Example' },
    to: [{ email: 'Cliente@Dominio.com' }],
    subject: 'Bienvenido',
    text: 'Hola',
    ...overrides,
  };
}

export function smtpRequest(overrides: Partial<EmailRequest> = {}): EmailRequest {
  return apiRequest({
    transport: {
      type: 'smtp',
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        auth: { user: 'notificaciones@example.com', pass: 'not-a-real-password' },
        dkim: {
          domainName: 'example.com',
          keySelector: 'mail',
          privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
        },
      },
    },
    ...overrides,
  });
}
