import { timingSafeEqual } from 'node:crypto';
import type { ReplayGuard } from './replay-guard';

export type WebhookRejectionReason = 'invalid_signature' | 'stale_timestamp';

// La petición no viene del proveedor o está fuera de su ventana de tiempo: se responde 401
export class WebhookRejectedError extends Error {
  constructor(readonly reason: WebhookRejectionReason) {
    super(reason);
    this.name = 'WebhookRejectedError';
  }
}

// Identificador del webhook reservado tras verificar la firma
export interface WebhookClaim {
  // Libera la reserva si el procesado falla, para que el reintento del proveedor se procese
  release(): Promise<void>;
}

// Comparación en tiempo constante; la longitud no es secreta
export function constantTimeEquals(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// null si la clave ya estaba reservada (repetición)
export async function claimOnce(
  replayGuard: ReplayGuard,
  key: string,
  ttlMs: number,
): Promise<WebhookClaim | null> {
  if (!(await replayGuard.claim(key, ttlMs))) return null;
  return { release: () => replayGuard.release(key) };
}
