import type { ApiProviderName } from './email';

export type ProviderEventType =
  | 'delivered'
  | 'bounced' // rebote permanente
  | 'complained'
  | 'unsubscribed'
  | 'temporary_failure'; // solo se registra

// Evento de entrega recibido por webhook, ya traducido del formato del proveedor
export interface ProviderEvent {
  provider: ApiProviderName;
  type: ProviderEventType;
  recipient: string;
  occurredAt: Date;
  messageId?: string; // id interno que enviamos con el mensaje
  providerMessageId?: string;
  raw: unknown; // cuerpo original del proveedor, para auditoría
}
