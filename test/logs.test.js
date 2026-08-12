'use strict';

// Testes puros da Central Logs API (RFC-0002) — validate/argv/mapper/spawn,
// sem journald real, sem Node-RED.
const assert = require('assert');
const path = require('path');
const {
  logsEndpoints, validateLogsQuery, buildJournalctlArgs, mapJournalLine,
  parseAllowlist, boundedSpawn, priorityLevel,
  DEFAULT_ALLOWLIST, DEFAULT_LIMIT, MAX_LIMIT, GREP_MAX_LEN,
} = require('../lib/logs');

const ep = (id) => logsEndpoints.find((e) => e.id === id);
const reqWith = (query) => ({ query });
const ALLOW = ['myio.service', 'myio-api.service'];
let passed = 0;
async function ok(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }

(async () => {
  console.log('logs:');

  // ── superfície ─────────────────────────────────────────────────────────────
  await ok('2 endpoints GET com exec próprio; nenhum aceita a initial key', () => {
    assert.strictEqual(logsEndpoints.length, 2);
    for (const e of logsEndpoints) {
      assert.strictEqual(e.method, 'get');
      assert.strictEqual(typeof e.exec, 'function');
      assert.ok(!e.allowInitialKey, e.id);
    }
    assert.strictEqual(ep('logs').path, '/logs');
    assert.strictEqual(ep('logsServices').path, '/logs/services');
  });

  await ok('parseAllowlist: string CSV, array, vazio → default', () => {
    assert.deepStrictEqual(parseAllowlist('a.service, b.service'), ['a.service', 'b.service']);
    assert.deepStrictEqual(parseAllowlist(['x.service']), ['x.service']);
    assert.deepStrictEqual(parseAllowlist(''), DEFAULT_ALLOWLIST);
    assert.deepStrictEqual(parseAllowlist(null), DEFAULT_ALLOWLIST);
  });

  // ── validate: allowlist + since obrigatórios ───────────────────────────────
  await ok('sem service → 400; fora da allowlist → 400', () => {
    assert.strictEqual(validateLogsQuery(reqWith({ since: '2026-08-11T08:00:00Z' }), ALLOW).error, true);
    const v = validateLogsQuery(reqWith({ service: 'sshd.service', since: '2026-08-11T08:00:00Z' }), ALLOW);
    assert.strictEqual(v.error, true);
    assert.strictEqual(v.statusCode, 400);
    assert.match(v.body.error, /allowlist/);
  });

  await ok('sem since / since inválido → 400', () => {
    assert.strictEqual(validateLogsQuery(reqWith({ service: 'myio.service' }), ALLOW).error, true);
    assert.strictEqual(validateLogsQuery(reqWith({ service: 'myio.service', since: 'ontem' }), ALLOW).error, true);
  });

  await ok('until inválido → 400; válido → mantido', () => {
    assert.strictEqual(
      validateLogsQuery(reqWith({ service: 'myio.service', since: '2026-08-11T08:00:00Z', until: 'zzz' }), ALLOW).error,
      true
    );
    const v = validateLogsQuery(reqWith({ service: 'myio.service', since: '2026-08-11T08:00:00Z', until: '2026-08-11T09:00:00Z' }), ALLOW);
    assert.strictEqual(v.until, '2026-08-11T09:00:00Z');
  });

  // ── priority ───────────────────────────────────────────────────────────────
  await ok('priority: default 7; nome → número; numérico; inválido → 400', () => {
    const base = { service: 'myio.service', since: '2026-08-11T08:00:00Z' };
    assert.strictEqual(validateLogsQuery(reqWith(base), ALLOW).priority, 7);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, priority: 'warning' }), ALLOW).priority, 4);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, priority: 'err' }), ALLOW).priority, 3);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, priority: '3' }), ALLOW).priority, 3);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, priority: 'verbose' }), ALLOW).error, true);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, priority: '9' }), ALLOW).error, true);
  });

  // ── grep / limit / order ───────────────────────────────────────────────────
  await ok('grep length-capped → 400 acima do teto', () => {
    const base = { service: 'myio.service', since: '2026-08-11T08:00:00Z' };
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, grep: 'x'.repeat(GREP_MAX_LEN) }), ALLOW).grep.length, GREP_MAX_LEN);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, grep: 'x'.repeat(GREP_MAX_LEN + 1) }), ALLOW).error, true);
  });

  await ok('limit: default 500, teto 5000, inválido → default', () => {
    const base = { service: 'myio.service', since: '2026-08-11T08:00:00Z' };
    assert.strictEqual(validateLogsQuery(reqWith(base), ALLOW).limit, DEFAULT_LIMIT);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, limit: '999999' }), ALLOW).limit, MAX_LIMIT);
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, limit: '-1' }), ALLOW).limit, DEFAULT_LIMIT);
  });

  await ok('order: default asc; desc aceito; outros → asc', () => {
    const base = { service: 'myio.service', since: '2026-08-11T08:00:00Z' };
    assert.strictEqual(validateLogsQuery(reqWith(base), ALLOW).order, 'asc');
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, order: 'DESC' }), ALLOW).order, 'desc');
    assert.strictEqual(validateLogsQuery(reqWith({ ...base, order: 'sideways' }), ALLOW).order, 'asc');
  });

  // ── argv builder: array exato, sem shell ───────────────────────────────────
  await ok('buildJournalctlArgs: argv exato (asc, sem until)', () => {
    const v = validateLogsQuery(reqWith({ service: 'myio-api.service', since: '2026-08-11T08:00:00Z', priority: 'warning' }), ALLOW);
    assert.deepStrictEqual(buildJournalctlArgs(v), [
      '-u', 'myio-api.service',
      '--since', '2026-08-11T08:00:00Z',
      '-p', '4',
      '-n', '500',
      '-o', 'json',
      '--no-pager',
    ]);
  });

  await ok('buildJournalctlArgs: until + desc → --until e -r; nunca --follow', () => {
    const v = validateLogsQuery(reqWith({
      service: 'myio.service', since: '2026-08-11T08:00:00Z',
      until: '2026-08-11T09:00:00Z', order: 'desc', limit: '10',
    }), ALLOW);
    const args = buildJournalctlArgs(v);
    assert.deepStrictEqual(args, [
      '-u', 'myio.service',
      '--since', '2026-08-11T08:00:00Z',
      '--until', '2026-08-11T09:00:00Z',
      '-p', '7',
      '-n', '10',
      '-o', 'json',
      '--no-pager',
      '-r',
    ]);
    assert.ok(!args.includes('-f') && !args.includes('--follow'));
    for (const a of args) assert.strictEqual(typeof a, 'string'); // array puro, nada de shell string
  });

  // ── mapper journal-JSON → entry ────────────────────────────────────────────
  await ok('mapJournalLine: ts µs→ISO, priority→level, pid int, unit', () => {
    const entry = mapJournalLine({
      __REALTIME_TIMESTAMP: '1786783272004000', // µs
      PRIORITY: '3',
      MESSAGE: 'pg pool error: connection timeout',
      _PID: '812',
      _SYSTEMD_UNIT: 'myio-api.service',
    });
    assert.strictEqual(entry.ts, new Date(1786783272004).toISOString());
    assert.strictEqual(entry.priority, 3);
    assert.strictEqual(entry.level, 'err');
    assert.strictEqual(entry.message, 'pg pool error: connection timeout');
    assert.strictEqual(entry.pid, 812);
    assert.strictEqual(entry.unit, 'myio-api.service');
  });

  await ok('mapJournalLine: MESSAGE em bytes → utf8; campos ausentes → null', () => {
    const entry = mapJournalLine({ MESSAGE: [111, 108, 195, 161] }); // "olá"
    assert.strictEqual(entry.message, 'olá');
    assert.strictEqual(entry.ts, null);
    assert.strictEqual(entry.priority, null);
    assert.strictEqual(entry.level, null);
    assert.strictEqual(entry.pid, null);
    assert.strictEqual(entry.unit, null);
  });

  await ok('priorityLevel: 0..7 mapeados; fora da faixa → null', () => {
    assert.strictEqual(priorityLevel(0), 'emerg');
    assert.strictEqual(priorityLevel(4), 'warning');
    assert.strictEqual(priorityLevel(7), 'debug');
    assert.strictEqual(priorityLevel(8), null);
    assert.strictEqual(priorityLevel(null), null);
  });

  // ── boundedSpawn (genérico, testado com o próprio node) ────────────────────
  await ok('boundedSpawn: coleta stdout e resolve no exit 0', async () => {
    const out = await boundedSpawn(process.execPath, ['-e', 'console.log("linha1"); console.log("linha2")']);
    assert.match(out, /linha1\r?\nlinha2/);
  });

  await ok('boundedSpawn: exit ≠ 0 → rejeita com mensagem curta (sem argv)', async () => {
    await assert.rejects(
      () => boundedSpawn(process.execPath, ['-e', 'console.error("boom"); process.exit(2)']),
      (err) => {
        assert.match(err.message, /exited with code 2/);
        assert.match(err.message, /boom/);
        assert.ok(!err.message.includes('-e'), 'não vaza argv');
        return true;
      }
    );
  });

  await ok('boundedSpawn: estoura maxBytes → mata e rejeita', async () => {
    await assert.rejects(
      () => boundedSpawn(
        process.execPath,
        ['-e', 'setInterval(() => process.stdout.write("x".repeat(65536)), 1)'],
        { maxBytes: 256 * 1024, timeoutMs: 10000 }
      ),
      /exceeded/
    );
  });

  console.log('\n' + passed + ' testes OK');
})().catch((err) => { console.error(err); process.exit(1); });
