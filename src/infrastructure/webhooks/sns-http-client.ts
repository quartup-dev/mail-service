type Fetch = typeof fetch;

// Peticiones salientes a SNS; las URLs ya están validadas por SnsMessageVerifier e isSnsUrl
export class SnsHttpClient {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly timeoutMs: number,
  ) {}

  async downloadCertificate(url: string): Promise<string> {
    const response = await this.get(url);
    return response.text();
  }

  async confirmSubscription(subscribeUrl: string): Promise<void> {
    await this.get(subscribeUrl);
  }

  // Sin seguir redirecciones: solo se habla con el host validado
  private async get(url: string): Promise<Response> {
    const response = await this.fetchFn(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // Solo el origen: la URL de confirmación lleva el token de la suscripción
      throw new Error(`SNS answered ${response.status} to GET ${new URL(url).origin}/`);
    }
    return response;
  }
}
