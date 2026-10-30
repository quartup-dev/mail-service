import { createHmac } from 'node:crypto';
import type { Clock } from '../../application/ports/clock';
import type { ReplayGuard } from './replay-guard';
import {
  claimOnce,
  constantTimeEquals,
  WebhookRejectedError,
  type WebhookClaim,
} from './webhook-verification';

const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
// Un token aceptado puede repetirse mientras su timestamp esté dentro de la ventana, en ambos sentidos
const REPLAY_TTL_MS = 2 * TIMESTAMP_TOLERANCE_MS;

export interface MailgunSignature {
  timestamp: string; // segundos desde epoch
  token: string;
  signature: string; // HMAC-SHA256 en hex
}

export interface MailgunWebhookVerifierDeps {
  signingKey: string; // MAILGUN_WEBHOOK_SIGNING_KEY
  replayGuard: ReplayGuard;
  clock: Clock;
}

export class MailgunWebhookVerifier {
  constructor(private readonly deps: MailgunWebhookVerifierDeps) {}

  // Lanza WebhookRejectedError si la petición no es de Mailgun o está fuera de plazo.
  // Devuelve null si el token ya se recibió
  async verify({ timestamp, token, signature }: MailgunSignature): Promise<WebhookClaim | null> {
    const expected = createHmac('sha256', this.deps.signingKey)
      .update(timestamp + token)
      .digest('hex');
    if (!constantTimeEquals(signature, expected)) {
      throw new WebhookRejectedError('invalid_signature');
    }
    if (!this.isRecent(timestamp)) throw new WebhookRejectedError('stale_timestamp');
    return claimOnce(this.deps.replayGuard, `mailgun:${token}`, REPLAY_TTL_MS);
  }

  // Ni más de 5 minutos de antigüedad ni más de 5 minutos en el futuro
  private isRecent(timestamp: string): boolean {
    const sentAtMs = Number(timestamp) * 1_000;
    const ageMs = this.deps.clock.now().getTime() - sentAtMs;
    return Number.isFinite(sentAtMs) && Math.abs(ageMs) <= TIMESTAMP_TOLERANCE_MS;
  }
}
