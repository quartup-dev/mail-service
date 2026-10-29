// Espera a que la condición se cumpla, comprobándola cada pocos milisegundos
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs = 5_000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
