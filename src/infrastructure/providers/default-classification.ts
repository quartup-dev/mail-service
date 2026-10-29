// Regla por defecto de la tabla de clasificación, para lo que no cubren los casos explícitos
// de cada proveedor: sin respuesta (red), HTTP 408, 429 o 5xx → transitorio; resto, permanente

// Códigos de Node para fallos de red sin respuesta del servidor
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export function isNetworkError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
