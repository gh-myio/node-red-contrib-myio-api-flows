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
const { endpoints } = require('./lib/endpoints');
const auth = require('./lib/auth');

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
    const isEnabled = (ep) => config['ep_' + ep.id] !== false;

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

    // auth X-API-Key (opt-in): se a credential apiKey estiver vazia, rotas abertas.
    const apiKey = (node.credentials && node.credentials.apiKey) || '';

    // rotas que ESTE node adicionou — para remoção limpa no redeploy.
    const registered = []; // { method, fullPath }
    let served = 0;

    function makeHandler(ep) {
      return async function (req, res) {
        try {
          // 0) auth — X-API-Key (só barra quando a key está configurada)
          const a = auth.checkApiKey(req, apiKey);
          if (!a.ok) {
            res.status(a.status).json(a.body);
            node.status({ fill: 'yellow', shape: 'ring', text: ep.id + ' 401' });
            return;
          }

          let params = null;
          if (typeof ep.validate === 'function') {
            const v = ep.validate(req, ctx);
            if (v && v.error) {
              res.status(v.statusCode || 400).json(v.body || { error: 'invalid' });
              node.status({ fill: 'yellow', shape: 'ring', text: ep.id + ' 400' });
              return;
            }
            if (v && v.params) params = v.params;
          }

          const pool = pgNode.getPool();
          const result = await pool.query(ep.sql, params || []);
          const out = ep.format(result.rows, ctx) || {};

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
    for (const ep of endpoints) {
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

    // remove SÓ as rotas deste node do router do Express (evita duplicar em redeploy)
    node.on('close', function (done) {
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
  RED.nodes.registerType('myio-api-flows', MyioApiFlowsNode, {
    credentials: { apiKey: { type: 'password' } },
  });
};
