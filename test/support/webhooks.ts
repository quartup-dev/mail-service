import { createHmac, createSign, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Clock } from '../../src/application/ports/clock';
import type { SnsMessage } from '../../src/infrastructure/webhooks/sns-message-verifier';
import type { MailgunEventData } from '../../src/interfaces/http/schemas/webhooks';

export const MAILGUN_SIGNING_KEY = 'test-mailgun-signing-key';

// Cuerpo de un webhook de Mailgun firmado con la clave de los tests y la hora del reloj
export function signedMailgunWebhook(
  clock: Clock,
  eventData: Partial<MailgunEventData> & { recipient: string },
  signature: { timestamp?: string; token?: string } = {},
) {
  const timestamp = signature.timestamp ?? String(Math.floor(clock.now().getTime() / 1_000));
  const token = signature.token ?? randomBytes(25).toString('hex');
  return {
    signature: {
      timestamp,
      token,
      signature: createHmac('sha256', MAILGUN_SIGNING_KEY)
        .update(timestamp + token)
        .digest('hex'),
    },
    'event-data': {
      event: 'delivered',
      timestamp: clock.now().getTime() / 1_000,
      ...eventData,
    },
  };
}

// Clave y certificado autofirmado solo para tests (test/fixtures/sns), en lugar del certificado de SNS
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/sns/${name}`, import.meta.url), 'utf8');
export const SNS_TEST_CERTIFICATE = fixture('test-signing-cert.pem');
const SNS_TEST_PRIVATE_KEY = fixture('test-signing-key.pem');

export const SNS_REGION = 'eu-west-1';
export const SNS_TOPIC_ARN = 'arn:aws:sns:eu-west-1:123456789012:mail-service-events';
export const SNS_CERT_URL =
  'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem';

const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
];

export type SnsTestMessage = Record<string, string>;

// Mensaje de SNS firmado como lo firma AWS, con la clave de los tests
export function signedSnsMessage(clock: Clock, fields: SnsTestMessage = {}): SnsMessage {
  const message: SnsTestMessage & Omit<SnsMessage, 'Signature'> = {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: SNS_TOPIC_ARN,
    Message: '{}',
    Timestamp: clock.now().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: SNS_CERT_URL,
    ...fields,
  };
  const names = message.Type === 'Notification' ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
  const stringToSign = names
    .filter((name) => message[name] !== undefined)
    .map((name) => `${name}\n${message[name]}\n`)
    .join('');
  const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  const signature = createSign(algorithm).update(stringToSign).sign(SNS_TEST_PRIVATE_KEY, 'base64');
  return { ...message, Signature: fields.Signature ?? signature };
}
