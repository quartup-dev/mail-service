import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Formato: ms_<clientId>_<secret>. El secreto es base64url y puede contener "_" y "-",
// así que solo se separa por los dos primeros "_"
const API_KEY = /^ms_([a-z0-9-]{3,32})_(.+)$/;
const SECRET_BYTES = 32;
const HASH_PREFIX = 'hmac-sha256:';

export interface ParsedApiKey {
  clientId: string;
  secret: string;
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = API_KEY.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { clientId: match[1], secret: match[2] };
}

export function generateApiKey(clientId: string): { key: string; secret: string } {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { key: `ms_${clientId}_${secret}`, secret };
}

// Solo se guarda este hash; el pepper vive en API_KEY_PEPPER, fuera de la base de datos
export function hashApiKeySecret(secret: string, pepper: Buffer): string {
  return HASH_PREFIX + createHmac('sha256', pepper).update(secret).digest('base64');
}

// Comparación en tiempo constante
export function apiKeySecretMatches(secret: string, hash: string, pepper: Buffer): boolean {
  const expected = Buffer.from(hashApiKeySecret(secret, pepper));
  const actual = Buffer.from(hash);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
