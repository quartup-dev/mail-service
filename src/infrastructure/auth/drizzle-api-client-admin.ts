import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Clock } from '../../application/ports/clock';
import type { TransportType } from '../../domain/email';
import type { Database } from '../db/client';
import { apiClients, apiKeys } from '../db/schema';
import { generateApiKey, hashApiKeySecret } from './api-keys';

export type ApiClientAdminErrorCode =
  | 'INVALID_CLIENT_ID'
  | 'CLIENT_EXISTS'
  | 'CLIENT_NOT_FOUND'
  | 'TOO_MANY_ACTIVE_KEYS'
  | 'KEY_NOT_FOUND';

export class ApiClientAdminError extends Error {
  constructor(
    readonly code: ApiClientAdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientAdminError';
  }
}

export interface ClientSettings {
  name: string;
  allowedTransports: TransportType[];
  allowedFromDomains: string[] | null;
  rateLimitPerMinute: number | null;
}

export interface ClientSummary extends ClientSettings {
  id: string;
  status: 'active' | 'disabled';
  keys: Array<{
    keyId: string;
    status: 'active' | 'revoked';
    createdAt: Date;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }>;
}

const CLIENT_ID = /^[a-z0-9-]{3,32}$/;
const MAX_ACTIVE_KEYS = 2; // dos para rotar sin cortes

// Gestión de clientes y keys para el CLI. Cada operación es una única sentencia o una transacción
export class DrizzleApiClientAdmin {
  constructor(
    private readonly db: Database,
    private readonly pepper: Buffer,
    private readonly clock: Clock,
  ) {}

  async createClient(id: string, settings: ClientSettings): Promise<void> {
    if (!CLIENT_ID.test(id)) {
      throw new ApiClientAdminError(
        'INVALID_CLIENT_ID',
        `Client id must match ${CLIENT_ID.source}`,
      );
    }
    const now = this.clock.now();
    const inserted = await this.db
      .insert(apiClients)
      .values({ id, ...settings, status: 'active', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: apiClients.id })
      .returning({ id: apiClients.id });
    if (inserted.length === 0) {
      throw new ApiClientAdminError('CLIENT_EXISTS', `Client ${id} already exists`);
    }
  }

  async updateClient(id: string, patch: Partial<ClientSettings>): Promise<void> {
    await this.updateClientRow(id, patch);
  }

  // Los clientes no se borran: se desactivan
  async setClientStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
    await this.updateClientRow(id, { status });
  }

  // Bloquea la fila del cliente antes de contar sus keys activas: dos creaciones simultáneas
  // no pueden superar el máximo. La key en claro solo se devuelve aquí
  async createKey(
    clientId: string,
    options: { expiresAt?: Date } = {},
  ): Promise<{ keyId: string; key: string }> {
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [client] = await tx
        .select({ id: apiClients.id })
        .from(apiClients)
        .where(eq(apiClients.id, clientId))
        .for('update');
      if (!client) throw clientNotFound(clientId);

      const active = await tx
        .select({ keyId: apiKeys.keyId })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.clientId, clientId),
            eq(apiKeys.status, 'active'),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
          ),
        );
      if (active.length >= MAX_ACTIVE_KEYS) {
        throw new ApiClientAdminError(
          'TOO_MANY_ACTIVE_KEYS',
          `Client ${clientId} already has ${MAX_ACTIVE_KEYS} active keys; revoke one first`,
        );
      }

      const keyId = newKeyId(now);
      const { key, secret } = generateApiKey(clientId);
      await tx.insert(apiKeys).values({
        clientId,
        keyId,
        hash: hashApiKeySecret(secret, this.pepper),
        status: 'active',
        createdAt: now,
        expiresAt: options.expiresAt ?? null,
      });
      return { keyId, key };
    });
  }

  async revokeKey(clientId: string, keyId: string): Promise<void> {
    const revoked = await this.db
      .update(apiKeys)
      .set({ status: 'revoked', revokedAt: this.clock.now() })
      .where(
        and(eq(apiKeys.clientId, clientId), eq(apiKeys.keyId, keyId), eq(apiKeys.status, 'active')),
      )
      .returning({ keyId: apiKeys.keyId });
    if (revoked.length === 0) {
      throw new ApiClientAdminError(
        'KEY_NOT_FOUND',
        `Client ${clientId} has no active key ${keyId}`,
      );
    }
  }

  async list(): Promise<ClientSummary[]> {
    const clients = await this.db.select().from(apiClients).orderBy(asc(apiClients.id));
    const keys = await this.db
      .select({
        clientId: apiKeys.clientId,
        keyId: apiKeys.keyId,
        status: apiKeys.status,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .orderBy(asc(apiKeys.createdAt), asc(apiKeys.keyId));

    return clients.map((client) => ({
      id: client.id,
      name: client.name,
      status: client.status,
      allowedTransports: client.allowedTransports,
      allowedFromDomains: client.allowedFromDomains,
      rateLimitPerMinute: client.rateLimitPerMinute,
      keys: keys
        .filter((key) => key.clientId === client.id)
        .map(({ keyId, status, createdAt, expiresAt, revokedAt }) => ({
          keyId,
          status,
          createdAt,
          expiresAt,
          revokedAt,
        })),
    }));
  }

  private async updateClientRow(
    id: string,
    patch: Partial<ClientSettings> & { status?: 'active' | 'disabled' },
  ): Promise<void> {
    const updated = await this.db
      .update(apiClients)
      .set({ ...patch, updatedAt: this.clock.now() })
      .where(eq(apiClients.id, id))
      .returning({ id: apiClients.id });
    if (updated.length === 0) throw clientNotFound(id);
  }
}

function clientNotFound(id: string): ApiClientAdminError {
  return new ApiClientAdminError('CLIENT_NOT_FOUND', `Client ${id} does not exist`);
}

// k_<año>_<mes>_<aleatorio>: legible al rotar y único aunque se creen varias en el mismo mes
function newKeyId(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `k_${now.getUTCFullYear()}_${month}_${randomBytes(3).toString('hex')}`;
}
