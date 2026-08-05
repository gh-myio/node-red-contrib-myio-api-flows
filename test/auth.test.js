'use strict';

// Testes puros do middleware X-API-Key (sem Node-RED).
const assert = require('assert');
const auth = require('../lib/auth');

const reqWith = (val) => ({ get: (h) => (h.toLowerCase() === 'x-api-key' ? val : undefined) });
let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

console.log('auth:');

ok('safeEqual: iguais → true', () => {
  assert.strictEqual(auth.safeEqual('myio_abc123', 'myio_abc123'), true);
});
ok('safeEqual: diferentes → false', () => {
  assert.strictEqual(auth.safeEqual('myio_abc123', 'myio_abc124'), false);
});
ok('safeEqual: tamanhos diferentes → false (sem throw)', () => {
  assert.strictEqual(auth.safeEqual('curta', 'uma-key-bem-mais-longa'), false);
});

ok('checkApiKey: sem key configurada → ok (rotas abertas)', () => {
  assert.deepStrictEqual(auth.checkApiKey(reqWith('qualquer'), ''), { ok: true, matched: null });
  assert.deepStrictEqual(auth.checkApiKey(reqWith(undefined), null), { ok: true, matched: null });
  assert.deepStrictEqual(auth.checkApiKey(reqWith('x'), ['', null]), { ok: true, matched: null });
});
ok('checkApiKey: key certa → ok + matched', () => {
  assert.deepStrictEqual(auth.checkApiKey(reqWith('K'), 'K'), { ok: true, matched: 'K' });
});
ok('checkApiKey: conjunto de keys — matched identifica qual bateu', () => {
  const r1 = auth.checkApiKey(reqWith('FULL'), ['FULL', 'INITIAL']);
  assert.deepStrictEqual(r1, { ok: true, matched: 'FULL' });
  const r2 = auth.checkApiKey(reqWith('INITIAL'), ['FULL', 'INITIAL']);
  assert.deepStrictEqual(r2, { ok: true, matched: 'INITIAL' });
});
ok('checkApiKey: conjunto de keys — nenhuma bate → 401', () => {
  const r = auth.checkApiKey(reqWith('OUTRA'), ['FULL', 'INITIAL']);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 401);
});
ok('checkApiKey: entradas vazias no conjunto são ignoradas', () => {
  const r = auth.checkApiKey(reqWith('FULL'), ['FULL', '']);
  assert.deepStrictEqual(r, { ok: true, matched: 'FULL' });
});
ok('checkApiKey: header ausente → 401 missing', () => {
  const r = auth.checkApiKey(reqWith(undefined), 'K');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 401);
  assert.match(r.body.error, /missing/);
});
ok('checkApiKey: key errada → 401 invalid', () => {
  const r = auth.checkApiKey(reqWith('X'), 'K');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 401);
  assert.match(r.body.error, /invalid/);
});
ok('readHeader: via headers cru (sem req.get)', () => {
  assert.strictEqual(auth.readHeader({ headers: { 'x-api-key': 'Z' } }), 'Z');
});

console.log('\n' + passed + ' testes OK');
