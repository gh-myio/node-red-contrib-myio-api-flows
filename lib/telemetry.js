'use strict';

/**
 * RFC-0001 — Telemetry Query API (ED-1097)
 *
 * Endpoints GET read-only sobre a telemetria local da central, no mesmo shape
 * declarativo de lib/endpoints.js ({ id, method, path, sql, validate, format }).
 *
 * Garantias (ver docs/RFC-0001-Telemetry-Query-API.md):
 *   - Bounded : slave_id (ou ambient_id no consumption) + from são obrigatórios —
 *               toda query ancora no índice composto e é limitada no tempo;
 *               nunca full-scan de hypertable (a central é uma placa ARM).
 *   - Capped  : limit default 500, teto 5000 server-side.
 *   - Binds   : valores só chegam ao SQL como bind params ($1..$n). A única
 *               exceção é o ORDER BY: validado contra allowlist {asc,desc} e
 *               injetado como fragmento literal ASC/DESC.
 *   - Version-safe: só colunas user-facing estáveis (TimescaleDB 1.7.5 e 2.18.0).
 *
 * Auth: as rotas passam pelo mesmo check X-API-Key do handler — telemetria
 * exige a CENTRAL_API_KEY (não tem allowInitialKey).
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000; // hard cap — protege a placa ARM

function bad(msg) {
  return { error: true, statusCode: 400, body: { error: msg } };
}

/**
 * Parse/validação dos parâmetros comuns (slave_id, from, to, limit, order,
 * channel). Retorna { error, ... } (400) ou os valores normalizados.
 */
function parseCommon(req, opts) {
  const q = (req && req.query) || {};
  const hasChannel = !!(opts && opts.hasChannel);
  const optionalSlave = !!(opts && opts.optionalSlave);

  let slave = null;
  if (q.slave_id != null && q.slave_id !== '') {
    slave = parseInt(q.slave_id, 10);
    if (!Number.isInteger(slave)) return bad('slave_id must be an integer');
  }
  if (!optionalSlave && slave === null) return bad('slave_id (integer) is required');

  const from = q.from;
  if (!from || Number.isNaN(Date.parse(from))) return bad('from (ISO-8601 timestamp) is required');

  let to = null;
  if (q.to != null && q.to !== '') {
    if (Number.isNaN(Date.parse(q.to))) return bad('to must be an ISO-8601 timestamp');
    to = q.to;
  }

  let limit = parseInt(q.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  // allowlist — nunca vira bind, vira fragmento literal ASC/DESC
  const order = String(q.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let channel = null;
  if (hasChannel && q.channel != null && q.channel !== '') {
    channel = parseInt(q.channel, 10);
    if (!Number.isInteger(channel)) return bad('channel must be an integer when provided');
  }

  return { slave, from, to, limit, order, channel };
}

// `to` default now() resolvido no SQL: COALESCE($n::timestamptz, now()).
const SQL = {
  energy: `SELECT timestamp, slave_id, value, value_reactive
FROM consumption_realtime
WHERE slave_id = $1
  AND timestamp >= $2
  AND timestamp <= COALESCE($3::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $4;`,

  pulses: `SELECT timestamp, slave_id, channel, value, reading
FROM channel_pulse_log
WHERE slave_id = $1
  AND ($2::int IS NULL OR channel = $2)
  AND timestamp >= $3
  AND timestamp <= COALESCE($4::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $5;`,

  actuator: `SELECT timestamp, slave_id, channel, type, action_type, "user", value
FROM logs
WHERE slave_id = $1
  AND ($2::int IS NULL OR channel = $2)
  AND timestamp >= $3
  AND timestamp <= COALESCE($4::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $5;`,

  temperature: `SELECT timestamp, slave_id, value
FROM temperature_history
WHERE slave_id = $1
  AND timestamp >= $2
  AND timestamp <= COALESCE($3::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $4;`,

  rawEnergy: `SELECT id, slave_id, value,
       datetime AS datetime_epoch,
       to_timestamp(datetime) AS timestamp
FROM raw_energy
WHERE slave_id = $1
  AND datetime >= extract(epoch FROM $2::timestamptz)
  AND datetime <= extract(epoch FROM COALESCE($3::timestamptz, now()))
ORDER BY datetime {ORDER}
LIMIT $4;`,

  consumption: `SELECT id, timestamp, slave_id, ambient_id, value, type
FROM consumption
WHERE ($1::int IS NULL OR slave_id = $1)
  AND ($2::int IS NULL OR ambient_id = $2)
  AND ($3::text IS NULL OR type = $3::enum_consumption_type)
  AND timestamp >= $4
  AND timestamp <= COALESCE($5::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $6;`,
};

function withOrder(tpl, order) {
  return tpl.replace('{ORDER}', order);
}

// payload comum: { source, slave_id, count, rows } (RFC-0001).
// `v` é o retorno do validate (o handler repassa) — carrega meta.source/slave_id.
function telemetryFormat(rows, ctx, v) {
  const meta = (v && v.meta) || {};
  return {
    payload: {
      source: meta.source || null,
      slave_id: meta.slave_id != null ? meta.slave_id : null,
      count: rows.length,
      rows,
    },
    statusCode: 200,
    headers: JSON_HEADERS,
  };
}

const telemetryEndpoints = [
  // ── GET /telemetry/energy — consumption_realtime (por slave, sem channel) ──
  {
    id: 'telemetryEnergy',
    method: 'get',
    path: '/telemetry/energy',
    sql: withOrder(SQL.energy, 'DESC'),
    validate(req) {
      const c = parseCommon(req, {});
      if (c.error) return c;
      return {
        params: [c.slave, c.from, c.to, c.limit],
        sql: withOrder(SQL.energy, c.order),
        meta: { source: 'consumption_realtime', slave_id: c.slave },
      };
    },
    format: telemetryFormat,
  },

  // ── GET /telemetry/pulses — channel_pulse_log (slave + channel opcional) ──
  {
    id: 'telemetryPulses',
    method: 'get',
    path: '/telemetry/pulses',
    sql: withOrder(SQL.pulses, 'DESC'),
    validate(req) {
      const c = parseCommon(req, { hasChannel: true });
      if (c.error) return c;
      return {
        params: [c.slave, c.channel, c.from, c.to, c.limit],
        sql: withOrder(SQL.pulses, c.order),
        meta: { source: 'channel_pulse_log', slave_id: c.slave },
      };
    },
    format: telemetryFormat,
  },

  // ── GET /telemetry/actuator — logs (estado/comandos de atuadores) ─────────
  {
    id: 'telemetryActuator',
    method: 'get',
    path: '/telemetry/actuator',
    sql: withOrder(SQL.actuator, 'DESC'),
    validate(req) {
      const c = parseCommon(req, { hasChannel: true });
      if (c.error) return c;
      return {
        params: [c.slave, c.channel, c.from, c.to, c.limit],
        sql: withOrder(SQL.actuator, c.order),
        meta: { source: 'logs', slave_id: c.slave },
      };
    },
    format: telemetryFormat,
  },

  // ── GET /telemetry/temperature — temperature_history ──────────────────────
  {
    id: 'telemetryTemperature',
    method: 'get',
    path: '/telemetry/temperature',
    sql: withOrder(SQL.temperature, 'DESC'),
    validate(req) {
      const c = parseCommon(req, {});
      if (c.error) return c;
      return {
        params: [c.slave, c.from, c.to, c.limit],
        sql: withOrder(SQL.temperature, c.order),
        meta: { source: 'temperature_history', slave_id: c.slave },
      };
    },
    format: telemetryFormat,
  },

  // ── GET /telemetry/raw-energy — raw_energy (datetime = epoch int) ─────────
  // default OFF (ligar via checkbox no editor)
  {
    id: 'telemetryRawEnergy',
    method: 'get',
    path: '/telemetry/raw-energy',
    defaultOff: true,
    sql: withOrder(SQL.rawEnergy, 'DESC'),
    validate(req) {
      const c = parseCommon(req, {});
      if (c.error) return c;
      return {
        params: [c.slave, c.from, c.to, c.limit],
        sql: withOrder(SQL.rawEnergy, c.order),
        meta: { source: 'raw_energy', slave_id: c.slave },
      };
    },
    format: telemetryFormat,
  },

  // ── GET /telemetry/consumption — consumption (slave_id OU ambient_id) ─────
  // default OFF (ligar via checkbox no editor)
  {
    id: 'telemetryConsumption',
    method: 'get',
    path: '/telemetry/consumption',
    defaultOff: true,
    sql: withOrder(SQL.consumption, 'DESC'),
    validate(req) {
      const q = (req && req.query) || {};
      const c = parseCommon(req, { optionalSlave: true });
      if (c.error) return c;
      let ambient = null;
      if (q.ambient_id != null && q.ambient_id !== '') {
        ambient = parseInt(q.ambient_id, 10);
        if (!Number.isInteger(ambient)) return bad('ambient_id must be an integer');
      }
      if (c.slave === null && ambient === null) {
        return bad('slave_id or ambient_id (integer) is required');
      }
      const type = (typeof q.type === 'string' && q.type !== '') ? q.type : null;
      return {
        params: [c.slave, ambient, type, c.from, c.to, c.limit],
        sql: withOrder(SQL.consumption, c.order),
        meta: { source: 'consumption', slave_id: c.slave },
      };
    },
    format: telemetryFormat,
  },
];

module.exports = { telemetryEndpoints, parseCommon, DEFAULT_LIMIT, MAX_LIMIT };
