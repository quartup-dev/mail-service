// Genera los ids de los mensajes (UUID v7 en producción)
export interface IdGenerator {
  next(): string;
}
