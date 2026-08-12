'use strict';

/**
 * node-red-contrib-myio-api-flows
 *
 * Encapsula o "flow API" das centrais MYIO (aba API: http-in + function +
 * postgresql + http-response × 5 endpoints) em UM único node, no espírito do
 * node-red-contrib-myio-data-fetcher.
 *
 * Registra dois tipos:
 *   - myio-pg          : config node com a conexão Postgres (pool compartilhado)
 *   - myio-api-flows   : node principal — sobe as 5 rotas em RED.httpNode
 */

const { Pool } = require('pg');
const {
  endpoints, CENTRAL_PRE_INITIAL_API_KEY, GCDR_BASE_URL, ENV_KEY_API, ENV_KEY_INITIAL,
} = require('./lib/endpoints');
const auth = require('./lib/auth');
const gcdr = require('./lib/gcdr');
const { telemetryEndpoints } = require('./lib/telemetry');
const { logsEndpoints } = require('./lib/logs');

// endpoints do flow API + telemetria (RFC-0001) + logs (RFC-0002) —
// mesmo pipeline/handler; logs executam via ep.exec (journalctl), sem SQL.
const allEndpoints = endpoints.concat(telemetryEndpoints, logsEndpoints);

// upsert key→value na tabela environment. A tabela não tem PK/unique em `key`
// (não dá pra usar ON CONFLICT) — UPDATE primeiro, INSERT se não afetou linha,
// numa transação.
async function upsertEnvironment(pool, entries) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of entries) {
      const u = await client.query('UPDATE environment SET value = $2 WHERE key = $1', [k, v]);
      if (u.rowCount === 0) {
        await client.query('INSERT INTO environment (key, value) VALUES ($1, $2)', [k, v]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    throw err;
  } finally {
    client.release();
  }
}

// keys de auth lidas da tabela environment A CADA request — rotação por UPDATE
// vale na requisição seguinte, sem redeploy (requisito ED-1096).
async function loadApiKeys(pool) {
  const r = await pool.query(
    'SELECT key, value FROM environment WHERE key IN ($1, $2)',
    [ENV_KEY_API, ENV_KEY_INITIAL]
  );
  const map = {};
  for (const row of r.rows) if (row.value) map[row.key] = row.value;
  return { full: map[ENV_KEY_API] || '', initial: map[ENV_KEY_INITIAL] || '' };
}

module.exports = function (RED) {
  // ───────────────────────────────────────────────────────────────────────
  // Config node: conexão Postgres (um pool por config node, compartilhado
  // entre os nodes myio-api-flows que o referenciam).
  // ───────────────────────────────────────────────────────────────────────
  function MyioPgConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.host = config.host || '127.0.0.1';
    node.port = parseInt(config.port, 10) || 5432;
    node.database = config.database || 'hubot';
    node.user = config.user || 'hubot';
    node.max = parseInt(config.max, 10) || 10;
    // senha via credentials (pode ser vazia — auth trust/peer local na central)
    const password = (node.credentials && node.credentials.password) || undefined;

    let pool = null;
    node.getPool = function () {
      if (!pool) {
        pool = new Pool({
          host: node.host,
          port: node.port,
          database: node.database,
          user: node.user,
          password: password,
          max: node.max,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });
        pool.on('error', (err) => node.error('myio-pg pool error: ' + err.message));
      }
      return pool;
    };

    node.on('close', function (done) {
      if (pool) {
        pool.end().then(() => { pool = null; done(); }).catch(() => { pool = null; done(); });
      } else {
        done();
      }
    });
  }
  RED.nodes.registerType('myio-pg', MyioPgConfigNode, {
    credentials: { password: { type: 'password' } },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Node principal: registra as rotas HTTP no servidor do Node-RED.
  // ───────────────────────────────────────────────────────────────────────
  function MyioApiFlowsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const pgNode = RED.nodes.getNode(config.pg);
    let basePath = (config.basePath || '/api').trim();
    if (!basePath.startsWith('/')) basePath = '/' + basePath;
    if (basePath.endsWith('/')) basePath = basePath.slice(0, -1); // normaliza sem barra final

    // toggles por endpoint: config['ep_<id>'] === false desliga a rota.
    // defaultOff (ex.: telemetry/raw-energy) exige opt-in explícito — flows
    // antigos (campo undefined) não ganham a rota sem alguém marcar o checkbox.
    const isEnabled = (ep) => ep.defaultOff
      ? config['ep_' + ep.id] === true
      : config['ep_' + ep.id] !== false;

    if (!pgNode) {
      node.status({ fill: 'red', shape: 'ring', text: 'sem config Postgres' });
      node.error('myio-api-flows: nenhum config node Postgres (myio-pg) selecionado');
      return;
    }

    // cache global (mesma semântica do global.get/set('mqttSyncStatus') do flow)
    const globalCtx = node.context().global;
    const cache = {
      get: (k) => globalCtx.get(k),
      set: (k, v) => globalCtx.set(k, v),
    };
    const ctx = { cache, node };

    // config dos endpoints de logs (RFC-0002): allowlist de units + paths.
    const logsConfig = {
      allowlist: config.logsUnits || '', // vazio → default do lib/logs.js
      journalctlPath: (config.journalctlPath || '').trim() || 'journalctl',
    };

    // rotas que ESTE node adicionou — para remoção limpa no redeploy.
    const registered = []; // { method, fullPath }
    let served = 0;

    function makeHandler(ep) {
      return async function (req, res) {
        try {
          const pool = pgNode.getPool();

          // 0) auth — X-API-Key contra as keys da tabela environment (ED-1096).
          //    CENTRAL_API_KEY vale em toda rota; CENTRAL_INITIAL_API_KEY só nas
          //    rotas com allowInitialKey (/state e /provision). Nenhuma key
          //    cadastrada → rota aberta (retrocompatível, opt-in).
          const keys = await loadApiKeys(pool);
          const allowed = ep.allowInitialKey ? [keys.full, keys.initial] : [keys.full];
          const a = auth.checkApiKey(req, allowed);
          if (!a.ok) {
            res.status(a.status).json(a.body);
            node.status({ fill: 'yellow', shape: 'ring', text: ep.id + ' 401' });
            return;
          }
          const authRole = a.matched
            ? (a.matched === keys.full ? 'full' : 'initial')
            : 'open';
          const reqCtx = { cache, node, authRole, logsConfig };

          let params = null;
          let envUpsert = null;
          let v = null;
          let sqlText = ep.sql;
          if (typeof ep.validate === 'function') {
            v = ep.validate(req, reqCtx);
            if (v && v.error) {
              res.status(v.statusCode || 400).json(v.body || { error: 'invalid' });
              node.status({ fill: 'yellow', shape: 'ring', text: ep.id + ' ' + (v.statusCode || 400) });
              return;
            }
            if (v && v.params) params = v.params;
            if (v && v.envUpsert) envUpsert = v.envUpsert;
            // validate pode devolver o SQL a usar (telemetria: ORDER BY asc/desc
            // validado por allowlist — nunca valor de request interpolado).
            if (v && v.sql) sqlText = v.sql;
          }

          // endpoints com execução própria (logs/RFC-0002: journalctl, sem SQL)
          if (typeof ep.exec === 'function') {
            const out = await ep.exec(v || {}, reqCtx) || {};
            if (out.headers) {
              for (const [h, val] of Object.entries(out.headers)) res.set(h, val);
            }
            res.status(out.statusCode || 200).json(out.payload);
            served += 1;
            node.status({ fill: 'green', shape: 'dot', text: served + ' req · ' + ep.id });
            return;
          }

          // modo environment{} do /provision: upsert direto, sem provision_central
          if (envUpsert) {
            await upsertEnvironment(pool, envUpsert);
            res.status(200).json({ ok: true, updated: envUpsert.map((e) => e[0]) });
            served += 1;
            node.status({ fill: 'green', shape: 'dot', text: served + ' req · ' + ep.id + ' env' });
            return;
          }

          const result = await pool.query(sqlText, params || []);
          const out = ep.format(result.rows, ctx, v || {}) || {};

          if (out.headers) {
            for (const [h, val] of Object.entries(out.headers)) res.set(h, val);
          }
          res.status(out.statusCode || 200).json(out.payload);

          served += 1;
          node.status({ fill: 'green', shape: 'dot', text: served + ' req · ' + ep.id });
        } catch (err) {
          node.error('myio-api-flows[' + ep.id + ']: ' + err.message, {});
          if (!res.headersSent) res.status(500).json({ error: err.message });
          node.status({ fill: 'red', shape: 'dot', text: ep.id + ' 500' });
        }
      };
    }

    // sobe as rotas habilitadas
    for (const ep of allEndpoints) {
      if (!isEnabled(ep)) continue;
      const fullPath = basePath + ep.path;
      RED.httpNode[ep.method](fullPath, makeHandler(ep));
      registered.push({ method: ep.method, fullPath });
    }

    node.status({
      fill: 'blue', shape: 'dot',
      text: registered.length + ' rota(s) em ' + basePath,
    });
    node.log('myio-api-flows: ' + registered.length + ' rota(s) registradas sob ' + basePath);

    // ── bootstrap GCDR (RFC-0056): troca pre-key + uuid da central pela
    // CENTRAL_INITIAL_API_KEY e grava na tabela environment. TOFU/idempotente.
    // Roda no deploy com retry (backoff até 1h) e re-sincroniza 1×/dia para
    // refletir rotação/revogação feita no GCDR. Nunca bloqueia as rotas.
    const gcdrUrl = (config.gcdrUrl || '').trim() || GCDR_BASE_URL;
    const RESYNC_MS = 24 * 60 * 60 * 1000;
    let bootstrapTimer = null;
    let closed = false;

    async function resolveCentralUuid(pool) {
      const fromConfig = (config.centralUuid || '').trim();
      if (fromConfig) return fromConfig;
      const r = await pool.query(
        "SELECT value FROM environment WHERE key IN ('CENTRAL_UUID', 'uuid') AND value IS NOT NULL LIMIT 1"
      );
      return (r.rows[0] && r.rows[0].value) || '';
    }

    function scheduleBootstrap(delayMs, attempt) {
      if (closed) return;
      bootstrapTimer = setTimeout(() => { runBootstrap(attempt); }, delayMs);
      if (bootstrapTimer.unref) bootstrapTimer.unref();
    }

    async function runBootstrap(attempt) {
      if (closed) return;
      try {
        const pool = pgNode.getPool();
        const uuid = await resolveCentralUuid(pool);
        if (!uuid) throw new Error('uuid da central indisponível (config do node ou tabela environment)');
        const out = await gcdr.fetchInitialKey({
          baseUrl: gcdrUrl, preKey: CENTRAL_PRE_INITIAL_API_KEY, uuid,
        });
        await upsertEnvironment(pool, [[ENV_KEY_INITIAL, out.apiKey]]);
        node.log('myio-api-flows: CENTRAL_INITIAL_API_KEY sincronizada do GCDR (cached=' + (out.cached === true) + ')');
        scheduleBootstrap(RESYNC_MS, 0);
      } catch (err) {
        const delay = Math.min(30000 * Math.pow(2, attempt), 3600000);
        node.warn('myio-api-flows: bootstrap GCDR falhou (' + err.message + ') — retry em ' + Math.round(delay / 1000) + 's');
        scheduleBootstrap(delay, attempt + 1);
      }
    }

    scheduleBootstrap(1000, 0);

    // remove SÓ as rotas deste node do router do Express (evita duplicar em redeploy)
    node.on('close', function (done) {
      closed = true;
      if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
      try {
        const stack = RED.httpNode && RED.httpNode._router && RED.httpNode._router.stack;
        if (stack && registered.length) {
          const want = new Set(registered.map((r) => r.method.toLowerCase() + ' ' + r.fullPath));
          for (let i = stack.length - 1; i >= 0; i--) {
            const layer = stack[i];
            if (!layer || !layer.route) continue;
            const p = layer.route.path;
            const methods = Object.keys(layer.route.methods || {});
            if (methods.some((m) => want.has(m + ' ' + p))) stack.splice(i, 1);
          }
        }
      } catch (e) {
        node.warn('myio-api-flows: falha ao remover rotas no close: ' + e.message);
      }
      done();
    });
  }
  RED.nodes.registerType('myio-api-flows', MyioApiFlowsNode);
};
