#!/usr/bin/env bash
# Genera una CA local y un certificado para Mailpit firmado por ella (solo desarrollo y test).
# Idempotente: si los ficheros ya existen, no hace nada.
set -euo pipefail

CERTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/docker/dev-certs"
CA_CERT="$CERTS_DIR/ca.pem"
CA_KEY="$CERTS_DIR/ca-key.pem"
SERVER_CERT="$CERTS_DIR/mailpit.pem"
SERVER_KEY="$CERTS_DIR/mailpit-key.pem"

if [[ -f "$CA_CERT" && -f "$SERVER_CERT" && -f "$SERVER_KEY" ]]; then
  echo "Los certificados de desarrollo ya existen en $CERTS_DIR"
  exit 0
fi

mkdir -p "$CERTS_DIR"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
  -subj "/CN=mail-service development CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$CA_KEY" -out "$CA_CERT" 2>/dev/null

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=mailpit" \
  -keyout "$SERVER_KEY" -out "$WORK_DIR/mailpit.csr" 2>/dev/null

cat > "$WORK_DIR/server.ext" <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:mailpit,DNS:localhost
EXT

openssl x509 -req -in "$WORK_DIR/mailpit.csr" -CA "$CA_CERT" -CAkey "$CA_KEY" \
  -CAcreateserial -CAserial "$WORK_DIR/ca.srl" -days 825 \
  -extfile "$WORK_DIR/server.ext" -out "$SERVER_CERT" 2>/dev/null

# El contenedor de Mailpit debe poder leer la clave; es un certificado solo de desarrollo
chmod 644 "$SERVER_KEY" "$SERVER_CERT" "$CA_CERT"
chmod 600 "$CA_KEY"

echo "Certificados de desarrollo generados en $CERTS_DIR"
