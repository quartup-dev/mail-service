// Validación anti-SSRF de hosts SMTP (fase 3 la implementa con DNS real)
export interface SmtpHostGuard {
  // Devuelve la IP validada a la que conectar o lanza SmtpHostNotAllowedError
  resolveAndValidate(host: string, port: number): Promise<{ host: string; ip: string }>;
}
