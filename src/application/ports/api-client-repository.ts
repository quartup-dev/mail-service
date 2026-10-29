import type { TransportType } from '../../domain/email';

export interface ApiClient {
  id: string;
  name: string;
  allowedTransports: TransportType[];
  allowedFromDomains?: string[];
  rateLimitPerMinute?: number;
}

export interface ApiClientRepository {
  authenticate(rawKey: string): Promise<ApiClient | null>;
}
