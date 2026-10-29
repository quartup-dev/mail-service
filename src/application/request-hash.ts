import { createHash, createHmac } from 'node:crypto';
import type { EmailRequest, SmtpServerConfig } from '../domain/email';

// Hash del cuerpo para comparar peticiones con la misma Idempotency-Key. La contraseña SMTP
// y la clave DKIM entran como HMAC con el pepper: el hash guardado no permite atacar
// esos secretos por fuerza bruta
export function computeRequestHash(request: EmailRequest, pepper: Buffer): string {
  return createHash('sha256')
    .update(JSON.stringify(withHashedSecrets(request, pepper)))
    .digest('hex');
}

function withHashedSecrets(request: EmailRequest, pepper: Buffer): EmailRequest {
  if (request.transport.type !== 'smtp') return request;

  const { auth, dkim, ...server } = request.transport.smtp;
  const hmac = (value: string) => createHmac('sha256', pepper).update(value).digest('base64');
  const smtp: SmtpServerConfig = {
    ...server,
    ...(auth && { auth: { ...auth, pass: hmac(auth.pass) } }),
    ...(dkim && { dkim: { ...dkim, privateKey: hmac(dkim.privateKey) } }),
  };
  return { ...request, transport: { type: 'smtp', smtp } };
}
