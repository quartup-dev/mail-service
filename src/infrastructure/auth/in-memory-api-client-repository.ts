import type { ApiClient, ApiClientRepository } from '../../application/ports/api-client-repository';
import type { Clock } from '../../application/ports/clock';
import { apiKeySecretMatches, parseApiKey } from './api-keys';

export interface StoredApiClient extends ApiClient {
  status: 'active' | 'disabled';
}

export interface StoredApiKey {
  clientId: string;
  keyId: string;
  hash: string;
  status: 'active' | 'revoked';
  expiresAt: Date | null;
}

// Para los tests de las rutas y para exportar la especificación OpenAPI sin base de datos
export class InMemoryApiClientRepository implements ApiClientRepository {
  private readonly clients = new Map<string, StoredApiClient>();
  private readonly keys: StoredApiKey[] = [];

  constructor(
    private readonly pepper: Buffer,
    private readonly clock: Clock,
  ) {}

  addClient(client: StoredApiClient): void {
    this.clients.set(client.id, structuredClone(client));
  }

  addKey(key: StoredApiKey): void {
    this.keys.push(structuredClone(key));
  }

  async authenticate(rawKey: string): Promise<ApiClient | null> {
    const parsed = parseApiKey(rawKey);
    const client = parsed && this.clients.get(parsed.clientId);
    if (!parsed || client?.status !== 'active') return null;

    const now = this.clock.now();
    const matches = this.keys.some(
      (key) =>
        key.clientId === client.id &&
        key.status === 'active' &&
        (key.expiresAt === null || key.expiresAt > now) &&
        apiKeySecretMatches(parsed.secret, key.hash, this.pepper),
    );
    if (!matches) return null;

    return toApiClient(client);
  }
}

function toApiClient(client: StoredApiClient): ApiClient {
  return {
    id: client.id,
    name: client.name,
    allowedTransports: [...client.allowedTransports],
    ...(client.allowedFromDomains && { allowedFromDomains: [...client.allowedFromDomains] }),
    ...(client.rateLimitPerMinute !== undefined && {
      rateLimitPerMinute: client.rateLimitPerMinute,
    }),
  };
}
