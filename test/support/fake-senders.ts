import type { EmailApiProvider } from '../../src/application/ports/email-api-provider';
import type { SendResult } from '../../src/application/ports/send-result';
import type { SmtpSender } from '../../src/application/ports/smtp-sender';
import type { ApiProviderName, EmailMessage, SmtpServerConfig } from '../../src/domain/email';
import type { FakeClock } from './fake-clock';

// Comportamiento común: registra los envíos y puede fallar en los próximos intentos
abstract class FakeSender {
  private readonly failures: Error[] = [];
  protected sentCount = 0;

  constructor(protected readonly clock: FakeClock) {}

  failNextWith(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  protected nextFailure(): Error | undefined {
    return this.failures.shift();
  }
}

export class FakeApiProvider extends FakeSender implements EmailApiProvider {
  readonly sent: EmailMessage[] = [];

  constructor(
    clock: FakeClock,
    readonly name: ApiProviderName = 'mailgun',
  ) {
    super(clock);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const failure = this.nextFailure();
    if (failure) throw failure;
    this.sent.push(structuredClone(message));
    return {
      provider: this.name,
      providerMessageId: `${this.name}-${++this.sentCount}`,
      acceptedAt: this.clock.now(),
    };
  }
}

export interface SmtpDelivery {
  message: EmailMessage;
  server: SmtpServerConfig;
  target: { ip: string };
}

export class FakeSmtpSender extends FakeSender implements SmtpSender {
  readonly sent: SmtpDelivery[] = [];
  private rejected: string[] = [];

  async send(
    message: EmailMessage,
    server: SmtpServerConfig,
    target: { ip: string },
  ): Promise<SendResult> {
    const failure = this.nextFailure();
    if (failure) throw failure;
    this.sent.push(structuredClone({ message, server, target }));
    return {
      provider: 'smtp',
      providerMessageId: `<smtp-${++this.sentCount}@example.com>`,
      acceptedAt: this.clock.now(),
      ...(this.rejected.length > 0 && { rejectedRecipients: this.rejected }),
    };
  }

  rejectRecipients(...emails: string[]): void {
    this.rejected = emails;
  }
}
