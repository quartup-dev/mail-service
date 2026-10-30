import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apiRequest, smtpRequest } from '../../../support/email-requests';
import { auth, BILLING_KEY, buildTestApp, CRM_KEY } from '../../../support/http';
import { signedMailgunWebhook } from '../../../support/webhooks';

const DOCUMENT_ID = 'openapi';

// Las respuestas reales cumplen el contrato publicado en openapi.yaml
describe('responses match openapi.yaml', () => {
  let document: OpenAPIV3_1.Document;
  let ajv: Ajv2020;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    document = (await SwaggerParser.parse('openapi.yaml')) as OpenAPIV3_1.Document;
    ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: DOCUMENT_ID, components: document.components });
  });

  afterEach(async () => {
    await app?.close();
  });

  function expectToMatchContract(
    path: string,
    method: 'get' | 'post',
    response: LightMyRequestResponse,
  ) {
    const declared = document.paths?.[path]?.[method]?.responses?.[response.statusCode] as
      OpenAPIV3_1.ResponseObject | undefined;
    const schema = declared?.content?.['application/json']?.schema as { $ref: string } | undefined;
    expect(schema, `${method} ${path} ${response.statusCode} is not declared`).toBeDefined();

    const validate = ajv.compile({ $ref: `${DOCUMENT_ID}${schema?.$ref ?? ''}` });
    const valid = validate(response.json());
    expect(validate.errors ?? [], JSON.stringify(response.json())).toEqual([]);
    expect(valid).toBe(true);
  }

  const post = (body: unknown, key = CRM_KEY, headers: Record<string, string> = {}) =>
    (app as FastifyInstance).inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { ...auth(key), ...headers },
      payload: body as Record<string, unknown>,
    });

  it('202, 200 and 409 of POST /v1/emails', async () => {
    ({ app } = buildTestApp());
    const created = await post(smtpRequest(), CRM_KEY, { 'idempotency-key': 'k' });
    const repeated = await post(smtpRequest(), CRM_KEY, { 'idempotency-key': 'k' });
    const conflict = await post(apiRequest(), CRM_KEY, { 'idempotency-key': 'k' });

    expect([created.statusCode, repeated.statusCode, conflict.statusCode]).toEqual([202, 200, 409]);
    for (const response of [created, repeated, conflict]) {
      expectToMatchContract('/v1/emails', 'post', response);
    }
  });

  it('400 and 401 of POST /v1/emails', async () => {
    ({ app } = buildTestApp());
    const invalid = await post({ ...apiRequest(), to: [] });
    const unauthorized = await post(apiRequest(), 'ms_crm_wrong');

    expect([invalid.statusCode, unauthorized.statusCode]).toEqual([400, 401]);
    expectToMatchContract('/v1/emails', 'post', invalid);
    expectToMatchContract('/v1/emails', 'post', unauthorized);
  });

  it('200 and 404 of GET /v1/emails/{id}', async () => {
    ({ app } = buildTestApp());
    const { id } = (await post(smtpRequest())).json<{ id: string }>();
    const found = await app.inject({
      method: 'GET',
      url: `/v1/emails/${id}`,
      headers: auth(CRM_KEY),
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/emails/0192f0c4-0000-7000-8000-999999999999',
      headers: auth(CRM_KEY),
    });

    expect([found.statusCode, missing.statusCode]).toEqual([200, 404]);
    expectToMatchContract('/v1/emails/{id}', 'get', found);
    expectToMatchContract('/v1/emails/{id}', 'get', missing);
  });

  it('429 of GET /v1/emails/{id}', async () => {
    ({ app } = buildTestApp());
    let response: LightMyRequestResponse | undefined;
    for (let i = 0; i < 4; i++) {
      response = await app.inject({
        method: 'GET',
        url: '/v1/emails/0192f0c4-0000-7000-8000-999999999999',
        headers: auth(BILLING_KEY),
      });
    }

    expect(response?.statusCode).toBe(429);
    expectToMatchContract('/v1/emails/{id}', 'get', response as LightMyRequestResponse);
  });

  it('400 and 401 of POST /v1/webhooks/mailgun', async () => {
    let clock;
    ({ app, clock } = buildTestApp());
    const signed = signedMailgunWebhook(clock, { recipient: 'a@dominio.com' });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mailgun',
      payload: { signature: signed.signature },
    });
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mailgun',
      payload: { ...signed, signature: { ...signed.signature, signature: 'forged' } },
    });

    expect([invalid.statusCode, unauthorized.statusCode]).toEqual([400, 401]);
    expectToMatchContract('/v1/webhooks/mailgun', 'post', invalid);
    expectToMatchContract('/v1/webhooks/mailgun', 'post', unauthorized);
  });
});
