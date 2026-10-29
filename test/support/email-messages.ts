import { randomUUID } from 'node:crypto';
import type { EmailMessage, EmailRequest } from '../../src/domain/email';
import { apiRequest } from './email-requests';

export function messageFrom(request: EmailRequest = apiRequest(), id = randomUUID()): EmailMessage {
  return { ...request, id };
}
