'use strict';

// Testes do bootstrap GCDR (lib/gcdr.js) contra um servidor HTTP local —
// sem rede externa, sem Node-RED.
const assert = require('assert');
const http = require('http');
const gcdr = require('../lib/gcdr');

let passed = 0;
async function ok(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }

// servidor que ecoa os headers e responde conforme a pre-key
const server = http.createServer((req, res) => {
  if (req.url !== '/api/v1/public/central/initial-key') {
    res.writeHead(404); return res.end();
  }
  if (req.headers['x-central-pre-key'] !== 'PRE' || !req.headers.uuid) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  const payload = {
    apiKey: 'gcdr_cust_test_' + req.headers.uuid,
    scopes: ['central-state:read', 'central-environment:read', 'central-environment:write'],
    customerId: '56614a70-326f-11ef-ad2c-53aeabe7d3fa',
    cached: false,
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.headers.uuid === 'raw') return res.end(JSON.stringify(payload));
  if (req.headers.uuid === 'empty') {
    return res.end(JSON.stringify({ success: true, data: {}, meta: {} }));
  }
  // formato real do GCDR: envelope { success, data, meta }
  res.end(JSON.stringify({ success: true, data: payload, meta: { requestId: 'r1' } }));
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/v1';

  console.log('gcdr:');

  await ok('bootstrap ok → apiKey por central (envelope GCDR { success, data, meta })', async () => {
    const out = await gcdr.fetchInitialKey({ baseUrl, preKey: 'PRE', uuid: 'central-1' });
    assert.strictEqual(out.apiKey, 'gcdr_cust_test_central-1');
    assert.ok(Array.isArray(out.scopes));
    assert.strictEqual(out.cached, false);
  });

  await ok('bootstrap ok → objeto cru (shorthand RFC-0056) continua aceito', async () => {
    const out = await gcdr.fetchInitialKey({ baseUrl, preKey: 'PRE', uuid: 'raw' });
    assert.strictEqual(out.apiKey, 'gcdr_cust_test_raw');
  });

  await ok('envelope sem apiKey → rejeita', async () => {
    await assert.rejects(
      () => gcdr.fetchInitialKey({ baseUrl, preKey: 'PRE', uuid: 'empty' }),
      /sem apiKey/
    );
  });

  await ok('pre-key errada → rejeita (HTTP 401)', async () => {
    await assert.rejects(
      () => gcdr.fetchInitialKey({ baseUrl, preKey: 'ERRADA', uuid: 'central-1' }),
      /HTTP 401/
    );
  });

  await ok('params obrigatórios ausentes → rejeita sem chamar rede', async () => {
    await assert.rejects(
      () => gcdr.fetchInitialKey({ baseUrl, preKey: '', uuid: 'central-1' }),
      /obrigat/
    );
  });

  server.close();
  console.log('\n' + passed + ' testes OK');
})().catch((err) => {
  server.close();
  console.error(err);
  process.exit(1);
});
