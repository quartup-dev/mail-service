import type { TransportType } from '../../domain/email';

// Una cola por transporte: un servidor SMTP lento no consume la capacidad de los envíos por API
export const EMAIL_QUEUE_BY_TRANSPORT: Record<TransportType, string> = {
  api: 'emails-api',
  smtp: 'emails-smtp',
};

export const MAINTENANCE_QUEUE = 'maintenance';

export const MAINTENANCE_JOBS = {
  sweepPendingEmails: 'sweep-pending-emails',
  applyRetention: 'apply-retention',
} as const;

// El job solo lleva el id: la base de datos es la fuente de verdad
export interface EmailJobData {
  messageId: string;
}
