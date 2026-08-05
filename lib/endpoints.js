'use strict';

/**
 * Definição declarativa dos endpoints do "flow API" das centrais MYIO,
 * portada 1:1 dos function/SQL nodes de
 *   src/NODE-RED/SA-CAVALCANTE/MOXUARA/functions/prod/API/*
 *
 * Cada endpoint:
 *   method   : 'get' | 'post'
 *   path     : sufixo após o basePath (ex.: '/state' → GET /api/state)
 *   sql      : statement executado no Postgres da central (funções do kit mqtt-sync/state-api)
 *   validate?: (req, ctx) => { error, statusCode, body } | { params } | undefined
 *              - retorna { error:true, statusCode, body } para curto-circuito (não roda SQL)
 *              - retorna { params: [...] } para parametrizar o SQL ($1, $2, ...)
 *              - undefined/null → roda o SQL sem params
 *   format   : (rows, ctx) => { payload, statusCode, headers? }
 *
 * ctx = { cache }  — cache é { get(key), set(key,value) } (global do Node-RED),
 * usado para manter `mqttSyncStatus` coerente entre GET e SET (igual ao flow atual).
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ── API keys (ED-1096 / RFC-0056 do GCDR) ────────────────────────────────────
// Pre-key compartilhada da frota (a mesma em toda central): NÃO autentica rota
// nenhuma — só serve para trocar, no GCDR, por uma CENTRAL_INITIAL_API_KEY
// única desta central (TOFU). Precisa bater com a env var
// CENTRAL_PRE_INITIAL_API_KEY do GCDR; raio de dano limitado ao bootstrap.
const CENTRAL_PRE_INITIAL_API_KEY = 'myio_pre_04a631bbe17de3d4d7c1e4084efb568b3874bd4cf022036c';

// GCDR de produção — endpoint de bootstrap: GET {base}/public/central/initial-key
const GCDR_BASE_URL = 'https://gcdr-api.a.myio-bas.com/api/v1';

// Rows da tabela `environment` onde as keys operacionais vivem (lidas a cada
// request — rotação por UPDATE vale na requisição seguinte, sem redeploy):
//   CENTRAL_API_KEY         → key completa: vale nas 5 rotas
//   CENTRAL_INITIAL_API_KEY → key de bootstrap (vinda do GCDR): só GET /state e
//                             POST /provision restrito a upsert de environment{}
const ENV_KEY_API = 'CENTRAL_API_KEY';
const ENV_KEY_INITIAL = 'CENTRAL_INITIAL_API_KEY';

// GET /state — agregação canônica do estado do banco da central.
const STATE_SQL = `SELECT json_build_object(
  'ambients', COALESCE((
    SELECT json_agg(json_build_object('id', id, 'name', name, 'order', "order"))
    FROM ambients
  ), '[]'::json),
  'slaves', COALESCE((
    SELECT json_agg(json_build_object('id', id, 'name', name, 'type', type,
                                       'addr_low', addr_low, 'addr_high', addr_high))
    FROM slaves
  ), '[]'::json),
  'channels', COALESCE((
    SELECT json_agg(json_build_object('id', id, 'name', name, 'channel', channel,
                                       'type', type, 'slave_id', slave_id))
    FROM channels
  ), '[]'::json),
  'rfir_devices', COALESCE((
    SELECT json_agg(json_build_object('id', id, 'name', name, 'type', type,
                                       'category', category, 'slave_id', slave_id))
    FROM rfir_devices
  ), '[]'::json),
  'ambients_rfir_slaves_rel', COALESCE((
    SELECT json_agg(json_build_object('ambient_id', ambient_id, 'slave_id', slave_id))
    FROM ambients_rfir_slaves_rel
  ), '[]'::json),
  'ambients_rfir_devices_rel', COALESCE((
    SELECT json_agg(json_build_object('ambient_id', ambient_id, 'rfir_device_id', rfir_device_id))
    FROM ambients_rfir_devices_rel
  ), '[]'::json),
  'environment', COALESCE((
    SELECT json_object_agg(key, value)
    FROM environment
  ), '{}'::json)
) AS state;`;

const EMPTY_STATE = {
  ambients: [], slaves: [], channels: [], rfir_devices: [],
  ambients_rfir_slaves_rel: [], ambients_rfir_devices_rel: [], environment: {},
};

const endpoints = [
  // ── GET /api/mqttSyncStatus ──────────────────────────────────────────────
  // Precedência: valor do banco → cache global → 'enable' (default legado).
  {
    id: 'getMqttSyncStatus',
    method: 'get',
    path: '/mqttSyncStatus',
    sql: 'SELECT get_mqtt_sync_status() AS mqtt_sync_status;',
    format(rows, ctx) {
      const fromDb = (rows && rows[0] && rows[0].mqtt_sync_status) || null;
      const status = fromDb || ctx.cache.get('mqttSyncStatus') || 'enable';
      ctx.cache.set('mqttSyncStatus', status);
      return { payload: status, statusCode: 200 };
    },
  },

  // ── GET /api/state ───────────────────────────────────────────────────────
  // Desembrulha payload[0].state; default defensivo em vez de 500.
  {
    id: 'getState',
    method: 'get',
    path: '/state',
    allowInitialKey: true, // CENTRAL_INITIAL_API_KEY também pode ler o state
    sql: STATE_SQL,
    format(rows) {
      const state = (rows && rows[0] && rows[0].state) || EMPTY_STATE;
      return { payload: state, statusCode: 200, headers: JSON_HEADERS };
    },
  },

  // ── POST /api/clearAllData ───────────────────────────────────────────────
  // ⚠️ Destrutivo — clear_all_data_central() apaga os dados de cadastro.
  {
    id: 'clearAllData',
    method: 'post',
    path: '/clearAllData',
    sql: 'SELECT clear_all_data_central() AS result;',
    format(rows) {
      const row = rows && rows[0] && rows[0].result;
      if (!row) return { payload: { error: 'no result' }, statusCode: 500, headers: JSON_HEADERS };
      return { payload: row, statusCode: 200, headers: JSON_HEADERS };
    },
  },

  // ── POST /api/provision ──────────────────────────────────────────────────
  // Dois modos, mutuamente exclusivos:
  //   devices[]      → provision_central($1::jsonb). 200, ou 207 se result.errors[].
  //                    Exige a CENTRAL_API_KEY (a initial key não autoriza) — 403.
  //   environment{}  → upsert key→value na tabela environment (sem provision_central).
  //                    Aceito com CENTRAL_API_KEY OU CENTRAL_INITIAL_API_KEY — é por
  //                    aqui que o pre-setup grava a CENTRAL_API_KEY (bootstrap).
  {
    id: 'provision',
    method: 'post',
    path: '/provision',
    allowInitialKey: true,
    sql: 'SELECT provision_central($1::jsonb) AS result;',
    validate(req, ctx) {
      const body = req.body;
      const authRole = (ctx && ctx.authRole) || 'open';

      if (body && body.environment !== undefined) {
        if (body.devices !== undefined) {
          return { error: true, statusCode: 400, body: { error: 'use devices[] OU environment{}, não ambos' } };
        }
        const env = body.environment;
        if (!env || typeof env !== 'object' || Array.isArray(env) || !Object.keys(env).length) {
          return { error: true, statusCode: 400, body: { error: 'environment{} deve ser um objeto key→value não vazio' } };
        }
        const entries = [];
        for (const [k, v] of Object.entries(env)) {
          if (typeof v !== 'string' && typeof v !== 'number') {
            return { error: true, statusCode: 400, body: { error: 'environment: valores devem ser string', key: k } };
          }
          if (k.length > 255 || String(v).length > 255) {
            return { error: true, statusCode: 400, body: { error: 'environment: key/value até 255 chars (varchar da tabela)', key: k } };
          }
          entries.push([k, String(v)]);
        }
        return { envUpsert: entries };
      }

      if (!body || !Array.isArray(body.devices)) {
        return { error: true, statusCode: 400, body: { error: 'missing devices[] (ou environment{})' } };
      }
      if (authRole === 'initial') {
        return { error: true, statusCode: 403, body: { error: 'CENTRAL_INITIAL_API_KEY só autoriza upsert de environment{}' } };
      }
      return { params: [JSON.stringify(body)] };
    },
    format(rows) {
      const row = rows && rows[0] && rows[0].result;
      if (!row) return { payload: { error: 'no result' }, statusCode: 500, headers: JSON_HEADERS };
      const statusCode = row.errors && row.errors.length ? 207 : 200;
      return { payload: row, statusCode, headers: JSON_HEADERS };
    },
  },

  // ── POST /api/setMqttSyncStatus ──────────────────────────────────────────
  // Valida envelope v2 (intent/mqttSyncStatus); $1::jsonb = envelope inteiro.
  {
    id: 'setMqttSyncStatus',
    method: 'post',
    path: '/setMqttSyncStatus',
    sql: 'SELECT set_mqtt_sync_status($1::jsonb) AS result;',
    validate(req, ctx) {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const intent = String(body.intent || '').toUpperCase();
      let status = String(body.mqttSyncStatus || body.status || '').toLowerCase();
      if (!status) {
        status = {
          DISABLE: 'disable', FORCE_DISABLE: 'disable',
          ENABLE: 'enable', FORCE_ENABLE: 'enable',
        }[intent] || '';
      }
      const isValid = intent === 'QUERY' || status === 'enable' || status === 'disable';
      if (!isValid) {
        return {
          error: true, statusCode: 400,
          body: {
            status: 'invalid', ok: false,
            error: 'payload inválido: informe intent (DISABLE|ENABLE|FORCE_*|QUERY) ou mqttSyncStatus (enable|disable)',
            intent: intent || null,
          },
        };
      }
      // cache em memória imediato (mantém GET/global em sincronia). QUERY não altera.
      if (status) ctx.cache.set('mqttSyncStatus', status);
      return { params: [JSON.stringify(body)] };
    },
    format(rows, ctx) {
      const row = rows && rows[0] && rows[0].result;
      if (!row) return { payload: { ok: false, error: 'no result' }, statusCode: 500, headers: JSON_HEADERS };
      const statusCode = row.ok === false ? 400 : 200;
      if (row.ok && row.mqttSyncStatus) ctx.cache.set('mqttSyncStatus', row.mqttSyncStatus);
      return { payload: row, statusCode, headers: JSON_HEADERS };
    },
  },
];

module.exports = {
  endpoints, STATE_SQL, EMPTY_STATE,
  CENTRAL_PRE_INITIAL_API_KEY, GCDR_BASE_URL, ENV_KEY_API, ENV_KEY_INITIAL,
};
