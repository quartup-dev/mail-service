import { randomUUIDv7 } from 'node:crypto';
import type { IdGenerator } from '../../application/ports/id-generator';

// UUID v7: ordenado por tiempo, lo que favorece los índices de la clave primaria
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return randomUUIDv7();
  }
}
