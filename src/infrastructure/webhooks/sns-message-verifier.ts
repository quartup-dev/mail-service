import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Clock } from '../../application/ports/clock';
import type { ReplayGuard } from './replay-guard';
import { claimOnce, WebhookRejectedError, type WebhookClaim } from './webhook-verification';

// SNS reintenta las entregas con el mismo Timestamp según su política de entrega
const MAX_AGE_MS = 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
// Un MessageId aceptado puede repetirse mientras su Timestamp esté dentro de la ventana
const REPLAY_TTL_MS = MAX_AGE_MS + MAX_CLOCK_SKEW_MS;

const ALGORITHM_BY_SIGNATURE_VERSION = new Map([
  ['1', 'RSA-SHA1'],
  ['2', 'RSA-SHA256'],
]);

// Campos firmados por tipo de mensaje, en el orden de la documentación de SNS
const SIGNED_FIELDS = new Map<string, Array<keyof SnsMessage>>([
  ['Notification', ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']],
  [
    'SubscriptionConfirmation',
    ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  ],
  [
    'UnsubscribeConfirmation',
    ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  ],
]);

// Campos de un mensaje de SNS que intervienen en la verificación
export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

export interface SnsMessageVerifierDeps {
  region: string; // AWS_REGION: el certificado se descarga de sns.<region>.amazonaws.com
  topicArns: string[]; // SES_SNS_TOPIC_ARNS
  downloadCertificate: (url: string) => Promise<string>; // PEM del certificado
  replayGuard: ReplayGuard;
  clock: Clock;
}

export class SnsMessageVerifier {
  // Solo URLs de sns.<region>.amazonaws.com y solo descargas correctas: SNS usa muy pocos certificados
  private readonly certificates = new Map<string, KeyObject>();

  constructor(private readonly deps: SnsMessageVerifierDeps) {}

  // Lanza WebhookRejectedError si el mensaje no viene de un topic permitido, no lo firmó SNS
  // o está fuera de plazo. Devuelve null si el MessageId ya se recibió
  async verify(message: SnsMessage): Promise<WebhookClaim | null> {
    // Antes que la firma: cualquiera puede crear un topic propio que SNS firma igual
    if (!this.deps.topicArns.includes(message.TopicArn)) {
      throw new WebhookRejectedError('unknown_topic');
    }
    const algorithm = ALGORITHM_BY_SIGNATURE_VERSION.get(message.SignatureVersion);
    const fields = SIGNED_FIELDS.get(message.Type);
    if (!algorithm || !fields) throw new WebhookRejectedError('invalid_signature');
    if (!isSnsUrl(message.SigningCertURL, this.deps.region, { pem: true })) {
      throw new WebhookRejectedError('untrusted_certificate_url');
    }

    const certificate = await this.certificateAt(message.SigningCertURL);
    const signed = verify(
      algorithm,
      Buffer.from(stringToSign(message, fields)),
      certificate,
      Buffer.from(message.Signature, 'base64'),
    );
    if (!signed) throw new WebhookRejectedError('invalid_signature');
    if (!this.isRecent(message.Timestamp)) throw new WebhookRejectedError('stale_timestamp');
    return claimOnce(this.deps.replayGuard, `ses:${message.MessageId}`, REPLAY_TTL_MS);
  }

  private async certificateAt(url: string): Promise<KeyObject> {
    const cached = this.certificates.get(url);
    if (cached) return cached;
    const certificate = createPublicKey(await this.deps.downloadCertificate(url));
    this.certificates.set(url, certificate);
    return certificate;
  }

  private isRecent(timestamp: string): boolean {
    const ageMs = this.deps.clock.now().getTime() - Date.parse(timestamp);
    return ageMs <= MAX_AGE_MS && ageMs >= -MAX_CLOCK_SKEW_MS;
  }
}

// "Campo\nvalor\n" por cada campo presente; Subject solo si viene
function stringToSign(message: SnsMessage, fields: Array<keyof SnsMessage>): string {
  return fields
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('');
}

// https://sns.<region>.amazonaws.com, sin credenciales ni puerto; validado con URL, no por subcadena
export function isSnsUrl(value: string, region: string, { pem = false } = {}): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.hostname === `sns.${region}.amazonaws.com` &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    (!pem || url.pathname.endsWith('.pem'))
  );
}
