'use strict';

// Testes puros da Telemetry Query API (RFC-0001) — validate/format/SQL,
// sem Postgres, sem Node-RED.
const assert = require('assert');
const { telemetryEndpoints, DEFAULT_LIMIT, MAX_LIMIT } = require('../lib/telemetry');

const ep = (id) => telemetryEndpoints.find((e) => e.id === id);
const reqWith = (query) => ({ query });
let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

console.log('telemetry:');

// ── superfície ───────────────────────────────────────────────────────────────
ok('6 endpoints GET, paths /telemetry/*', () => {
  assert.strictEqual(telemetryEndpoints.length, 6);
  for (const e of telemetryEndpoints) {
    assert.strictEqual(e.method, 'get');
    assert.ok(e.path.startsWith('/telemetry/'));
    assert.ok(!e.allowInitialKey, e.id + ' não pode aceitar a initial key');
  }
});

ok('raw-energy e consumption são defaultOff; os 4 principais não', () => {
  assert.strictEqual(ep('telemetryRawEnergy').defaultOff, true);
  assert.strictEqual(ep('telemetryConsumption').defaultOff, true);
  for (const id of ['telemetryEnergy', 'telemetryPulses', 'telemetryActuator', 'telemetryTemperature']) {
    assert.ok(!ep(id).defaultOff, id);
  }
});

// ── bounded: parâmetros obrigatórios ─────────────────────────────────────────
ok('energy: sem slave_id → 400', () => {
  const v = ep('telemetryEnergy').validate(reqWith({ from: '2026-08-05T08:00:00Z' }));
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('energy: sem from → 400', () => {
  const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '12' }));
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('energy: from inválido → 400', () => {
  const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '12', from: 'ontem' }));
  assert.strictEqual(v.error, true);
});

ok('energy: to inválido → 400', () => {
  const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '12', from: '2026-08-05T08:00:00Z', to: 'zzz' }));
  assert.strictEqual(v.error, true);
});

ok('energy: ok → params [slave, from, to=null, limit=500] + meta', () => {
  const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '12', from: '2026-08-05T08:00:00Z' }));
  assert.deepStrictEqual(v.params, [12, '2026-08-05T08:00:00Z', null, DEFAULT_LIMIT]);
  assert.deepStrictEqual(v.meta, { source: 'consumption_realtime', slave_id: 12 });
});

// ── capped: limit ────────────────────────────────────────────────────────────
ok('limit acima do teto é capado em 5000', () => {
  const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '1', from: '2026-08-05T08:00:00Z', limit: '999999' }));
  assert.strictEqual(v.params[3], MAX_LIMIT);
});

ok('limit inválido/negativo cai no default 500', () => {
  for (const limit of ['abc', '-5', '0']) {
    const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '1', from: '2026-08-05T08:00:00Z', limit }));
    assert.strictEqual(v.params[3], DEFAULT_LIMIT);
  }
});

// ── order: allowlist, nunca interpolação livre ───────────────────────────────
ok('order=asc → SQL com ASC; default e valores fora da allowlist → DESC', () => {
  const base = { slave_id: '1', from: '2026-08-05T08:00:00Z' };
  const asc = ep('telemetryEnergy').validate(reqWith({ ...base, order: 'asc' }));
  assert.match(asc.sql, /ORDER BY timestamp ASC/);
  const def = ep('telemetryEnergy').validate(reqWith(base));
  assert.match(def.sql, /ORDER BY timestamp DESC/);
  const inj = ep('telemetryEnergy').validate(reqWith({ ...base, order: 'desc; DROP TABLE x' }));
  assert.match(inj.sql, /ORDER BY timestamp DESC/);
  assert.ok(!inj.sql.includes('DROP'));
});

// ── channel opcional ─────────────────────────────────────────────────────────
ok('pulses: channel ausente → null no bind; presente → int', () => {
  const sem = ep('telemetryPulses').validate(reqWith({ slave_id: '3', from: '2026-08-05T00:00:00Z' }));
  assert.deepStrictEqual(sem.params, [3, null, '2026-08-05T00:00:00Z', null, DEFAULT_LIMIT]);
  const com = ep('telemetryPulses').validate(reqWith({ slave_id: '3', channel: '2', from: '2026-08-05T00:00:00Z' }));
  assert.strictEqual(com.params[1], 2);
});

ok('pulses: channel não-inteiro → 400', () => {
  const v = ep('telemetryPulses').validate(reqWith({ slave_id: '3', channel: 'x', from: '2026-08-05T00:00:00Z' }));
  assert.strictEqual(v.error, true);
});

ok('actuator: mesmo shape do pulses (slave, channel, from, to, limit)', () => {
  const v = ep('telemetryActuator').validate(reqWith({ slave_id: '7', from: '2026-08-05T00:00:00Z' }));
  assert.deepStrictEqual(v.params, [7, null, '2026-08-05T00:00:00Z', null, DEFAULT_LIMIT]);
  assert.strictEqual(v.meta.source, 'logs');
});

ok('temperature: params [slave, from, to, limit]', () => {
  const v = ep('telemetryTemperature').validate(reqWith({ slave_id: '9', from: '2026-08-05T00:00:00Z', to: '2026-08-05T01:00:00Z' }));
  assert.deepStrictEqual(v.params, [9, '2026-08-05T00:00:00Z', '2026-08-05T01:00:00Z', DEFAULT_LIMIT]);
});

// ── consumption: seletor slave_id OU ambient_id ──────────────────────────────
ok('consumption: sem slave_id e sem ambient_id → 400', () => {
  const v = ep('telemetryConsumption').validate(reqWith({ from: '2026-08-05T00:00:00Z' }));
  assert.strictEqual(v.error, true);
  assert.strictEqual(v.statusCode, 400);
});

ok('consumption: só ambient_id → ok (slave null)', () => {
  const v = ep('telemetryConsumption').validate(reqWith({ ambient_id: '4', from: '2026-08-05T00:00:00Z' }));
  assert.deepStrictEqual(v.params, [null, 4, null, '2026-08-05T00:00:00Z', null, DEFAULT_LIMIT]);
});

ok('consumption: type passa como bind (nunca interpolado)', () => {
  const v = ep('telemetryConsumption').validate(reqWith({ slave_id: '2', type: 'energy', from: '2026-08-05T00:00:00Z' }));
  assert.strictEqual(v.params[2], 'energy');
  assert.ok(!v.sql.includes("'energy'"));
});

// ── SQL shape: tabela certa, binds, janela obrigatória ──────────────────────
ok('SQL de cada endpoint: tabela, binds $n e WHERE bounded', () => {
  const expect = {
    telemetryEnergy: ['FROM consumption_realtime', 'slave_id = $1', 'timestamp >= $2', 'LIMIT $4'],
    telemetryPulses: ['FROM channel_pulse_log', 'slave_id = $1', 'timestamp >= $3', 'LIMIT $5'],
    telemetryActuator: ['FROM logs', 'slave_id = $1', 'timestamp >= $3', 'LIMIT $5'],
    telemetryTemperature: ['FROM temperature_history', 'slave_id = $1', 'timestamp >= $2', 'LIMIT $4'],
    telemetryRawEnergy: ['FROM raw_energy', 'datetime >= extract(epoch FROM $2::timestamptz)', 'LIMIT $4'],
    telemetryConsumption: ['FROM consumption', 'timestamp >= $4', 'LIMIT $6'],
  };
  for (const [id, fragments] of Object.entries(expect)) {
    const sql = ep(id).sql;
    for (const f of fragments) assert.ok(sql.includes(f), id + ' deve conter: ' + f);
    assert.ok(!sql.includes('{ORDER}'), id + ': placeholder {ORDER} não resolvido');
  }
});

ok('raw-energy: expõe datetime_epoch e timestamp convertido', () => {
  const sql = ep('telemetryRawEnergy').sql;
  assert.ok(sql.includes('datetime AS datetime_epoch'));
  assert.ok(sql.includes('to_timestamp(datetime) AS timestamp'));
});

// ── format ───────────────────────────────────────────────────────────────────
ok('format: envelope { source, slave_id, count, rows }', () => {
  const rows = [{ timestamp: 't1', slave_id: 12, value: 1 }];
  const v = ep('telemetryEnergy').validate(reqWith({ slave_id: '12', from: '2026-08-05T08:00:00Z' }));
  const out = ep('telemetryEnergy').format(rows, {}, v);
  assert.deepStrictEqual(out.payload, { source: 'consumption_realtime', slave_id: 12, count: 1, rows });
  assert.strictEqual(out.statusCode, 200);
  assert.strictEqual(out.headers['Content-Type'], 'application/json');
});

ok('format: sem meta (defensivo) → source/slave_id null', () => {
  const out = ep('telemetryEnergy').format([], {}, {});
  assert.deepStrictEqual(out.payload, { source: null, slave_id: null, count: 0, rows: [] });
});

console.log('\n' + passed + ' testes OK');
