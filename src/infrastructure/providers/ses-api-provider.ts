import {
  SendEmailCommand,
  type Destination,
  type MessageTag,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Clock } from '../../application/ports/clock';
import type { EmailApiProvider } from '../../application/ports/email-api-provider';
import type { SendResult } from '../../application/ports/send-result';
import type { Address, EmailMessage } from '../../domain/email';
import { toMailOptions } from './mail-options';

// Lo que usamos de SESv2Client: el test lo sustituye en la frontera
export interface SesClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

export interface SesApiProviderDeps {
  client: SesClient;
  configurationSet?: string;
  clock: Clock;
}

export class SesApiProvider implements EmailApiProvider {
  readonly name = 'ses' as const;

  constructor(private readonly deps: SesApiProviderDeps) {}

  // Siempre Content.Raw: el MIME sale del mismo mapeo que el envío SMTP
  async send(message: EmailMessage): Promise<SendResult> {
    const mime = await new MailComposer(toMailOptions(message)).compile().build();
    const output = await this.deps.client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from.email,
        Destination: destinationOf(message),
        Content: { Raw: { Data: mime } },
        EmailTags: tagsOf(message),
        // Los eventos de entrega llegan por SNS a través del configuration set
        ...(this.deps.configurationSet && { ConfigurationSetName: this.deps.configurationSet }),
      }),
    );
    return {
      provider: this.name,
      providerMessageId: output.MessageId ?? '',
      acceptedAt: this.deps.clock.now(),
    };
  }
}

// Bcc no va en las cabeceras del MIME: los destinatarios se pasan siempre explícitos, y solo
// las listas con direcciones (la supresión puede dejar vacío el to)
function destinationOf(message: EmailMessage): Destination {
  const list = (field: keyof Destination, addresses: Address[] = []) =>
    addresses.length > 0 ? { [field]: addresses.map((address) => address.email) } : {};
  return {
    ...list('ToAddresses', message.to),
    ...list('CcAddresses', message.cc),
    ...list('BccAddresses', message.bcc),
  };
}

// El tag messageId vuelve en los eventos de SES para correlacionarlos. Los tags del mensaje van
// como nombre con valor "true", con los caracteres no admitidos sustituidos por "_"
function tagsOf(message: EmailMessage): MessageTag[] {
  const names = new Set((message.tags ?? []).map((tag) => tag.replace(/[^A-Za-z0-9_-]/g, '_')));
  return [
    { Name: 'messageId', Value: message.id },
    ...[...names].map((name) => ({ Name: name, Value: 'true' })),
  ];
}
