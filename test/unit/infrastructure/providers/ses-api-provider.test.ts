import {
  AccountSuspendedException,
  BadRequestException,
  LimitExceededException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  NotFoundException,
  SendingPausedException,
  SESv2ServiceException,
  TooManyRequestsException,
  type SendEmailCommand,
  type SendEmailCommandInput,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { PermanentProviderError, TransientProviderError } from '../../../../src/domain/errors';
import {
  SesApiProvider,
  sesClientConfig,
  type SesApiProviderDeps,
  type SesClient,
} from '../../../../src/infrastructure/providers/ses-api-provider';
import { FakeClock } from '../../../support/fake-clock';
import { messageFrom } from '../../../support/email-messages';
import { apiRequest } from '../../../support/email-requests';

// Cliente simulado: registra la entrada de cada comando y responde como SESv2Client
class FakeSesClient implements SesClient {
  readonly inputs: SendEmailCommandInput[] = [];
  failure: Error | null = null;

  async send(command: SendEmailCommand): Promise<SendEmailCommandOutput> {
    if (this.failure) throw this.failure;
    this.inputs.push(command.input);
    return { MessageId: '0102019a-ses-message-id', $metadata: { httpStatusCode: 200 } };
  }
}

function providerWith(deps: Partial<Pick<SesApiProviderDeps, 'configurationSet'>> = {}) {
  const client = new FakeSesClient();
  const clock = new FakeClock();
  const provider = new SesApiProvider({ client, clock, ...deps });
  return { provider, client, clock };
}

function rawMimeOf(input: SendEmailCommandInput | undefined): string {
  return Buffer.from(input?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
}

describe('SesApiProvider', () => {
  it('sends the MIME message as raw content with every recipient in the destination', async () => {
    const { provider, client } = providerWith();
    const message = messageFrom(
      apiRequest({
        from: { email: 'notificaciones@example.com', name: 'Example' },
        to: [{ email: 'a@dominio.com', name: 'Ana' }],
        cc: [{ email: 'c@dominio.com' }],
        bcc: [{ email: 'd@dominio.com' }],
        subject: 'Factura',
      }),
    );

    await provider.send(message);

    const input = client.inputs[0];
    expect(input).toMatchObject({
      FromEmailAddress: 'notificaciones@example.com',
      Destination: {
        ToAddresses: ['a@dominio.com'],
        CcAddresses: ['c@dominio.com'],
        BccAddresses: ['d@dominio.com'],
      },
    });
    const mime = rawMimeOf(input);
    expect(mime).toContain('Subject: Factura');
    expect(mime).toContain('To: Ana <a@dominio.com>');
    // Los nombres de cabecera no distinguen mayúsculas; MailComposer escribe X-Mail-Service-ID
    expect(mime).toMatch(new RegExp(`^X-Mail-Service-Id: ${message.id}\r?$`, 'im'));
    expect(mime).not.toMatch(/^Bcc:/im);
  });

  // SES admite destinos sin To: la supresión puede dejar solo cc o bcc
  it('sends without To when the suppression left only cc recipients', async () => {
    const { provider, client } = providerWith();

    await provider.send(messageFrom(apiRequest({ to: [], cc: [{ email: 'c@dominio.com' }] })));

    expect(client.inputs[0]?.Destination).toEqual({ CcAddresses: ['c@dominio.com'] });
  });

  // SES solo admite [A-Za-z0-9_-] en nombres y valores de tags, y nombres sin repetir
  it('tags the message with its internal id and its tags, replacing unsupported characters', async () => {
    const { provider, client } = providerWith();
    const message = messageFrom(
      apiRequest({ tags: ['factura', 'pago mensual', 'pago_mensual', 'año'] }),
      '0192f0c4-0000-7000-8000-000000000001',
    );

    await provider.send(message);

    expect(client.inputs[0]?.EmailTags).toEqual([
      { Name: 'messageId', Value: '0192f0c4-0000-7000-8000-000000000001' },
      { Name: 'factura', Value: 'true' },
      { Name: 'pago_mensual', Value: 'true' },
      { Name: 'a_o', Value: 'true' },
    ]);
  });

  it('uses the configuration set when one is configured', async () => {
    const { provider, client } = providerWith({ configurationSet: 'mail-service-events' });

    await provider.send(messageFrom());

    expect(client.inputs[0]?.ConfigurationSetName).toBe('mail-service-events');
  });

  it('sends without configuration set when none is configured', async () => {
    const { provider, client } = providerWith();

    await provider.send(messageFrom());

    expect(client.inputs[0]).not.toHaveProperty('ConfigurationSetName');
  });

  it('returns the SES message id and the time of the clock', async () => {
    const { provider, clock } = providerWith();

    const result = await provider.send(messageFrom());

    expect(result).toEqual({
      provider: 'ses',
      providerMessageId: '0102019a-ses-message-id',
      acceptedAt: clock.now(),
    });
  });

  describe('error classification', () => {
    async function failureOf(error: Error) {
      const { provider, client } = providerWith();
      client.failure = error;
      return provider.send(messageFrom()).catch((failure: unknown) => failure);
    }

    const metadata = (httpStatusCode: number) => ({ $metadata: { httpStatusCode } });

    // Lo que no modela SESv2 llega como SESv2ServiceException con el nombre del error
    function serviceException(name: string, httpStatusCode: number): SESv2ServiceException {
      return new SESv2ServiceException({
        name,
        message: name,
        $fault: httpStatusCode >= 500 ? 'server' : 'client',
        ...metadata(httpStatusCode),
      });
    }

    it.each([
      new TooManyRequestsException({ message: 'Too many', ...metadata(429) }),
      new LimitExceededException({ message: 'Limit', ...metadata(400) }),
      serviceException('ThrottlingException', 400),
    ])('treats $name as transient', async (error) => {
      const failure = await failureOf(error);

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ provider: 'ses', code: `SES_${error.name}` });
    });

    it.each([
      new MessageRejected({ message: 'Rejected', ...metadata(400) }),
      new MailFromDomainNotVerifiedException({ message: 'Not verified', ...metadata(400) }),
      new AccountSuspendedException({ message: 'Suspended', ...metadata(400) }),
      new SendingPausedException({ message: 'Paused', ...metadata(400) }),
      new BadRequestException({ message: 'Bad request', ...metadata(400) }),
      new NotFoundException({ message: 'Not found', ...metadata(404) }),
    ])('treats $name as permanent', async (error) => {
      const failure = await failureOf(error);

      expect(failure).toBeInstanceOf(PermanentProviderError);
      expect(failure).toMatchObject({ provider: 'ses', code: `SES_${error.name}` });
    });

    it.each([500, 502, 503])('treats an unmodelled HTTP %i as transient', async (status) => {
      const failure = await failureOf(serviceException('Unknown', status));

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ code: `SES_HTTP_${status}` });
    });

    it('treats an error the SDK marks as retryable as transient', async () => {
      const error = Object.assign(serviceException('InternalFailure', 400), {
        $retryable: { throttling: false },
      });

      const failure = await failureOf(error);

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ code: 'SES_InternalFailure' });
    });

    it('treats HTTP 408 as transient by default', async () => {
      const failure = await failureOf(serviceException('RequestTimeout', 408));

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ code: 'SES_HTTP_408' });
    });

    it.each([
      [
        'a refused connection',
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      ],
      ['a timeout', Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })],
    ])('treats a network error without response (%s) as transient', async (_, error) => {
      const failure = await failureOf(error);

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ code: 'SES_NETWORK_ERROR' });
    });

    it('treats any other unmodelled 4xx as permanent', async () => {
      const failure = await failureOf(serviceException('AccessDeniedException', 403));

      expect(failure).toBeInstanceOf(PermanentProviderError);
      expect(failure).toMatchObject({ code: 'SES_HTTP_403' });
    });

    it('treats a local error, such as invalid input, as permanent', async () => {
      const failure = await failureOf(new TypeError('Invalid input'));

      expect(failure).toBeInstanceOf(PermanentProviderError);
      expect(failure).toMatchObject({ code: 'SES_ERROR', message: 'Invalid input' });
    });
  });
});

describe('sesClientConfig', () => {
  // Los reintentos los gestiona solo la cola
  it('disables the SDK retries and uses the configured region with request timeouts', () => {
    expect(sesClientConfig({ region: 'eu-west-1' })).toEqual({
      region: 'eu-west-1',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    });
  });
});
