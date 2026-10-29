// Subconjunto del logger que usan los casos de uso; Pino lo cumple
export interface Logger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}
