import type { IdGenerator } from '../../src/application/ports/id-generator';

export class SequentialIds implements IdGenerator {
  private counter = 0;

  next(): string {
    const suffix = String(++this.counter).padStart(12, '0');
    return `0192f0c4-0000-7000-8000-${suffix}`;
  }
}
