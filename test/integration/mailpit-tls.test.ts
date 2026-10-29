import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

// Requiere docker compose up y NODE_EXTRA_CA_CERTS con la CA local (bun run test:integration)
describe('Mailpit', () => {
  it('accepts STARTTLS on port 587 with certificate verification against the local CA', async () => {
    const transporter = nodemailer.createTransport({
      host: 'localhost',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    });

    try {
      await expect(transporter.verify()).resolves.toBe(true);
    } finally {
      transporter.close();
    }
  });
});
