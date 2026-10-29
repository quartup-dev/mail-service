// Proceso hijo del test de certificados: Node solo lee NODE_EXTRA_CA_CERTS al arrancar, así
// que el envío sin la CA local tiene que hacerse en un proceso lanzado sin esa variable.
// Imprime en stdout el resultado como JSON
import { ProviderError } from '../../src/domain/errors';
import { messageFrom } from './email-messages';
import { smtpRequest } from './email-requests';
import { MAILPIT_IP, MAILPIT_SERVER, mailpitSender } from './mailpit';

const sender = mailpitSender();
try {
  await sender.send(messageFrom(smtpRequest()), MAILPIT_SERVER, { ip: MAILPIT_IP });
  console.log(JSON.stringify({ sent: true }));
} catch (error) {
  console.log(
    JSON.stringify({
      sent: false,
      errorClass: error instanceof ProviderError ? error.name : String(error),
      code: error instanceof ProviderError ? error.code : null,
    }),
  );
} finally {
  sender.close();
}
