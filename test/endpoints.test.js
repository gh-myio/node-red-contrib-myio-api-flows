'use strict';

// Testes puros dos endpoints (validate/format) — sem Postgres, sem Node-RED.
// Roda com: npm test   (node test/endpoints.test.js)

const assert = require('assert');
const { endpoints } = require('../lib/endpoints');

function makeCache() {
  const store = {};
  return { get: (k) => store[k], set: (k, v) => { store[k] = v; }, _store: store };
}
const ep = (id) => endpoints.find((e) => e.id === id);
let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

console.log('endpoints:');

ok('getMqttSyncStatus: db vence cache/default', () => {
  const cache = makeCache(); cache.set('mqttSyncStatus', 'disable');
  const out = ep('getMqttSyncStatus').format([{ mqtt_sync_status: 'enable' }], { cache });
  assert.strictEqual(out.payload, 'enable');
  assert.strictEqual(cache.get('mqttSyncStatus'), 'enable'); // grava de volta
  assert.strictEqual(out.statusCode, 200);
});

ok('getMqttSyncStatus: sem db cai no cache', () => {
  const cache = makeCache(); cache.set('mqttSyncStatus', 'disable');
  const out = ep('getMqttSyncStatus').format([], { cache });
  assert.strictEqual(out.payload, 'disable');
});

ok('getMqttSyncStatus: sem db/cache → enable', () => {
  const out = ep('getMqttSyncStatus').format([{}], { cache: makeCache() });
  assert.strictEqual(out.payload, 'enable');
});

ok('getState: desembrulha state', () => {
  const state = { ambients: [{ id: 1 }], slaves: [], channels: [] };
  const out = ep('getState').format([{ state }]);
  assert.deepStrictEqual(out.payload, state);
  assert.strictEqual(out.headers['Content-Type'], 'application/json');
});

ok('getState: vazio → shape defensivo', () => {
  const out = ep('getState').format([]);
  assert.deepStrictEqual(out.payload.ambients, []);
  assert.ok('ambients_rfir_devices_rel' in out.payload);
});

ok('clearAllData: result → 200', () => {
  const out = ep('clearAllData').format([{ result: { status: 'ok', removed: {} } }]);
  assert.strictEqual(out.statusCode, 200);
  assert.strictEqual(out.payload.status, 'ok');
});

ok('clearAllData: sem result → 500', () => {
  const out = ep('clearAllData').format([]);
  assert.strictEqual(out.statusCode, 500);
});

ok('provision: sem devices[] nem environment{} → 400', () => {
  const v = ep('provision').validate({ body: { foo: 1 } });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('provision: com devices[] → params jsonb', () => {
  const body = { devices: [{ id: 1 }] };
  const v = ep('provision').validate({ body });
  assert.deepStrictEqual(v.params, [JSON.stringify(body)]);
});

ok('provision: devices[] com authRole=full → ok', () => {
  const body = { devices: [{ id: 1 }] };
  const v = ep('provision').validate({ body }, { authRole: 'full' });
  assert.deepStrictEqual(v.params, [JSON.stringify(body)]);
});

ok('provision: devices[] com authRole=initial → 403 (só environment{})', () => {
  const v = ep('provision').validate({ body: { devices: [] } }, { authRole: 'initial' });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 403);
});

ok('provision: environment{} → envUpsert (aceito com initial)', () => {
  const v = ep('provision').validate(
    { body: { environment: { CENTRAL_API_KEY: 'nova-key', foo: 'bar' } } },
    { authRole: 'initial' }
  );
  assert.deepStrictEqual(v.envUpsert, [['CENTRAL_API_KEY', 'nova-key'], ['foo', 'bar']]);
});

ok('provision: environment{} vazio → 400', () => {
  const v = ep('provision').validate({ body: { environment: {} } });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('provision: environment com valor não-string → 400', () => {
  const v = ep('provision').validate({ body: { environment: { k: { nested: true } } } });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('provision: environment com value > 255 chars → 400 (varchar da tabela)', () => {
  const v = ep('provision').validate({ body: { environment: { k: 'x'.repeat(256) } } });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('provision: devices[] E environment{} juntos → 400', () => {
  const v = ep('provision').validate({ body: { devices: [], environment: { k: 'v' } } });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('state e provision permitem initial key; demais não', () => {
  assert.strictEqual(ep('getState').allowInitialKey, true);
  assert.strictEqual(ep('provision').allowInitialKey, true);
  assert.ok(!ep('clearAllData').allowInitialKey);
  assert.ok(!ep('getMqttSyncStatus').allowInitialKey);
  assert.ok(!ep('setMqttSyncStatus').allowInitialKey);
});

ok('provision: errors[] → 207', () => {
  const out = ep('provision').format([{ result: { errors: ['x'] } }]);
  assert.strictEqual(out.statusCode, 207);
});

ok('setMqttSyncStatus: payload inválido → 400', () => {
  const v = ep('setMqttSyncStatus').validate({ body: { foo: 'bar' } }, { cache: makeCache() });
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('setMqttSyncStatus: intent DISABLE → status disable + cache', () => {
  const cache = makeCache();
  const v = ep('setMqttSyncStatus').validate({ body: { intent: 'DISABLE' } }, { cache });
  assert.deepStrictEqual(v.params, [JSON.stringify({ intent: 'DISABLE' })]);
  assert.strictEqual(cache.get('mqttSyncStatus'), 'disable');
});

ok('setMqttSyncStatus: QUERY é válido e não altera cache', () => {
  const cache = makeCache();
  const v = ep('setMqttSyncStatus').validate({ body: { intent: 'QUERY' } }, { cache });
  assert.ok(v.params);
  assert.strictEqual(cache.get('mqttSyncStatus'), undefined);
});

ok('setMqttSyncStatus: format ok:false → 400', () => {
  const out = ep('setMqttSyncStatus').format([{ result: { ok: false } }], { cache: makeCache() });
  assert.strictEqual(out.statusCode, 400);
});

console.log('\n' + passed + ' testes OK');
