import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { ApiClient, ApiClientRepository } from '../../application/ports/api-client-repository';
import type { Clock } from '../../application/ports/clock';
import type { Database } from '../db/client';
import { apiClients, apiKeys } from '../db/schema';
import { apiKeySecretMatches, parseApiKey } from './api-keys';

// Sin caché: una revocación o una desactivación tiene efecto en la siguiente petición
export class DrizzleApiClientRepository implements ApiClientRepository {
  constructor(
    private readonly db: Database,
    private readonly pepper: Buffer,
    private readonly clock: Clock,
  ) {}

  async authenticate(rawKey: string): Promise<ApiClient | null> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) return null;

    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.id, parsed.clientId), eq(apiClients.status, 'active')));
    if (!client) return null;

    const activeKeys = await this.db
      .select({ hash: apiKeys.hash })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.clientId, client.id),
          eq(apiKeys.status, 'active'),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, this.clock.now())),
        ),
      );
    // Se comparan todas (como mucho dos) para no revelar cuál coincide por el tiempo de respuesta
    const matches = activeKeys
      .map((key) => apiKeySecretMatches(parsed.secret, key.hash, this.pepper))
      .includes(true);
    if (!matches) return null;

    return {
      id: client.id,
      name: client.name,
      allowedTransports: client.allowedTransports,
      ...(client.allowedFromDomains && { allowedFromDomains: client.allowedFromDomains }),
      ...(client.rateLimitPerMinute !== null && { rateLimitPerMinute: client.rateLimitPerMinute }),
    };
  }
}
