// Reserva de identificadores de webhooks ya recibidos (token de Mailgun, MessageId de SNS)
export interface ReplayGuard {
  // true si la clave no estaba reservada; la reserva dura ttlMs
  claim(key: string, ttlMs: number): Promise<boolean>;
  // Libera la clave para que el reintento del proveedor se procese
  release(key: string): Promise<void>;
}
