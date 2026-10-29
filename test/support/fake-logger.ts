import type { Logger } from '../../src/application/ports/logger';

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  bindings: object;
  message: string;
}

export class FakeLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(bindings: object, message: string): void {
    this.entries.push({ level: 'info', bindings, message });
  }

  warn(bindings: object, message: string): void {
    this.entries.push({ level: 'warn', bindings, message });
  }

  error(bindings: object, message: string): void {
    this.entries.push({ level: 'error', bindings, message });
  }
}
