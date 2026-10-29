import type { SmtpHostGuard } from '../../src/application/ports/smtp-host-guard';
import { SmtpHostNotAllowedError } from '../../src/domain/errors';

export const VALIDATED_IP = '203.0.113.10';

export class FakeSmtpHostGuard implements SmtpHostGuard {
  readonly calls: Array<{ host: string; port: number }> = [];
  private readonly blocked = new Set<string>();

  async resolveAndValidate(host: string, port: number): Promise<{ host: string; ip: string }> {
    this.calls.push({ host, port });
    if (this.blocked.has(host)) throw new SmtpHostNotAllowedError(host, 'resolves to a private IP');
    return { host, ip: VALIDATED_IP };
  }

  block(host: string): void {
    this.blocked.add(host);
  }
}
