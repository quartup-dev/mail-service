export interface SecretBox {
  encrypt(plain: string): string; // siempre con la clave activa
  decrypt(cipher: string): string; // con la clave activa o la anterior, según el keyId; lanza UndecryptableSecretError
}
