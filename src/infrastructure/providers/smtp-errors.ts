import {
  PermanentProviderError,
  TransientProviderError,
  type ProviderError,
} from '../../domain/errors';

// Campos que Nodemailer añade a sus errores
interface NodemailerErrorFields {
  code?: string;
  responseCode?: number;
  originalCode?: string; // código de Node cuando falla el socket (ESOCKET)
}

// Códigos de verificación de certificado de Node (OpenSSL) y de nombre que no coincide
const TLS_CERTIFICATE_ERRORS = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Códigos de Nodemailer para fallos de red: conexión, socket (con el código de Node en
// originalCode), timeouts y DNS. Los certificados inválidos también llegan como ESOCKET
const NETWORK_ERRORS = new Set(['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS']);

type Classification = { permanent: boolean; code: string };

// Casos explícitos de la tabla de clasificación, en orden
export function classifySmtpError(error: unknown): ProviderError {
  const { permanent, code } = classify(fieldsOf(error));
  const ErrorClass = permanent ? PermanentProviderError : TransientProviderError;
  const message = error instanceof Error ? error.message : String(error);
  return new ErrorClass(message, 'smtp', code, { cause: error });
}

function classify({ code, responseCode, originalCode }: NodemailerErrorFields): Classification {
  if (originalCode !== undefined && TLS_CERTIFICATE_ERRORS.has(originalCode)) {
    return { permanent: true, code: 'SMTP_TLS_CERTIFICATE_INVALID' };
  }
  if (code === 'EAUTH' || responseCode === 535) {
    return { permanent: true, code: 'SMTP_AUTH_FAILED' };
  }
  if (responseCode !== undefined) {
    return { permanent: responseCode >= 500, code: `SMTP_${responseCode}` };
  }
  if (code === 'EENVELOPE') {
    return { permanent: true, code: 'SMTP_RECIPIENTS_REJECTED' };
  }
  if (code !== undefined && NETWORK_ERRORS.has(code)) {
    return { permanent: false, code: 'SMTP_NETWORK_ERROR' };
  }
  // Por defecto: los demás códigos de Nodemailer son errores locales o de protocolo; sin
  // código, un fallo de envío como el cierre del pool, que se puede reintentar
  if (code !== undefined) return { permanent: true, code: `SMTP_${code}` };
  return { permanent: false, code: 'SMTP_ERROR' };
}

function fieldsOf(error: unknown): NodemailerErrorFields {
  return typeof error === 'object' && error !== null ? error : {};
}
