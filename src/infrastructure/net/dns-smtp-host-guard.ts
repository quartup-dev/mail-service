import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { SmtpHostGuard } from '../../application/ports/smtp-host-guard';
import { matchesDomainPattern } from '../../domain/domain-pattern';
import { SmtpHostNotAllowedError } from '../../domain/errors';
import { isPublicIp } from './ip-ranges';

// 465: TLS implícito; 587: STARTTLS obligatorio. El 25 no se admite
const ALLOWED_PORTS = new Set([465, 587]);

// Todas las direcciones (A y AAAA) a las que resuelve un host
export type HostResolver = (host: string) => Promise<string[]>;

// getaddrinfo, como el resto del sistema: incluye /etc/hosts y el DNS de Docker (mailpit)
export const lookupAllAddresses: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export interface SmtpHostPolicy {
  allowedHosts: string[]; // SMTP_ALLOWED_HOSTS; vacía = cualquier host público
  allowedPrivateHosts: string[]; // SMTP_ALLOWED_PRIVATE_HOSTS; solo desarrollo
}

export class DnsSmtpHostGuard implements SmtpHostGuard {
  constructor(
    private readonly policy: SmtpHostPolicy,
    private readonly resolve: HostResolver,
  ) {}

  async resolveAndValidate(host: string, port: number): Promise<{ host: string; ip: string }> {
    if (!ALLOWED_PORTS.has(port)) {
      throw new SmtpHostNotAllowedError(host, `port ${port} is not allowed`);
    }

    if (!this.isInAllowList(host)) {
      throw new SmtpHostNotAllowedError(host, 'it is not in SMTP_ALLOWED_HOSTS');
    }

    const ips = isIP(host) ? [host] : await this.resolve(host);
    const [ip] = ips;
    if (!ip) throw new SmtpHostNotAllowedError(host, 'it does not resolve to any address');
    // Si alguna IP no es pública se rechaza el host entero: el resolver podría devolverla después
    if (!this.isAllowedPrivateHost(host) && !ips.every(isPublicIp)) {
      throw new SmtpHostNotAllowedError(host, 'it resolves to a non-public address');
    }
    return { host, ip };
  }

  private isInAllowList(host: string): boolean {
    const { allowedHosts } = this.policy;
    return (
      allowedHosts.length === 0 ||
      allowedHosts.some((pattern) => matchesDomainPattern(host, pattern))
    );
  }

  // Solo desarrollo (p. ej. mailpit); en producción la configuración exige que esté vacía
  private isAllowedPrivateHost(host: string): boolean {
    const normalized = host.toLowerCase();
    return this.policy.allowedPrivateHosts.some((allowed) => allowed.toLowerCase() === normalized);
  }
}
