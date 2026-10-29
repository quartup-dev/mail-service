// Reloj inyectable: barrido, retención y caducidad de keys no leen la hora del sistema directamente
export interface Clock {
  now(): Date;
}
