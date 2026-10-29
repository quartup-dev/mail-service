import nodemailer from 'nodemailer';
import type { SmtpServerConfig } from '../../src/domain/email';
import { NodemailerSmtpSender } from '../../src/infrastructure/providers/nodemailer-smtp-sender';
import { SystemClock } from '../../src/infrastructure/system-clock';
import { waitFor } from './wait-for';

// Mailpit de docker compose: STARTTLS obligatorio en el 587 con un certificado de la CA local
// para "localhost", y cualquier usuario y contraseña
const MAILPIT_API_URL = process.env.TEST_MAILPIT_API_URL ?? 'http://localhost:8025/api/v1';

export const MAILPIT_SERVER: SmtpServerConfig = {
  host: 'localhost',
  port: 587,
  auth: { user: 'test', pass: 'not-a-real-password' },
};

export const MAILPIT_IP = '127.0.0.1';

export function mailpitSender(): NodemailerSmtpSender {
  return new NodemailerSmtpSender({
    createTransport: (options) => nodemailer.createTransport(options),
    clock: new SystemClock(),
    settings: {
      poolMaxConnections: 1,
      rateLimitPerSecond: 10,
      transportCacheTtlMs: 60_000,
      transportCacheMax: 5,
      connectionTimeoutMs: 5_000,
      greetingTimeoutMs: 5_000,
      socketTimeoutMs: 10_000,
    },
  });
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Attachments: Array<{ PartID: string; FileName: string; ContentType: string }>;
  Inline: Array<{ PartID: string; FileName: string; ContentType: string; ContentID: string }>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_API_URL}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

// Espera a que llegue el correo con ese asunto (único por test) y lo devuelve completo
export async function receivedMessage(subject: string): Promise<MailpitMessage> {
  let id: string | undefined;
  await waitFor(async () => {
    const query = encodeURIComponent(`subject:"${subject}"`);
    const found = await getJson<{ messages: Array<{ ID: string }> }>(`/search?query=${query}`);
    id = found.messages[0]?.ID;
    return id !== undefined;
  });
  return getJson<MailpitMessage>(`/message/${id}`);
}

export function receivedHeaders(id: string): Promise<Record<string, string[]>> {
  return getJson<Record<string, string[]>>(`/message/${id}/headers`);
}

export async function receivedPart(id: string, partId: string): Promise<Buffer> {
  const response = await fetch(`${MAILPIT_API_URL}/message/${id}/part/${partId}`);
  return Buffer.from(await response.arrayBuffer());
}
