'use strict';

/**
 * RFC-0002 — Central Logs API (ED-1120)
 *
 * Endpoints GET read-only sobre o journal do systemd da central. Diferente do
 * resto do módulo (SQL via pool), aqui o dado vive no journald — o endpoint
 * spawna um `journalctl` LIMITADO e não-interativo. Este é o único caminho de
 * execução por processo do módulo, isolado neste arquivo.
 *
 * Garantias (ver docs/RFC-0002-Central-Logs-API.md):
 *   - Allowlist : `service` precisa bater exatamente com uma unit configurada
 *                 (default myio.service, myio-api.service) → fora dela, 400.
 *                 Não existe caminho para ler o journal inteiro ou dmesg.
 *   - Sem shell : spawn com ARRAY de argumentos — nunca string de shell, nunca
 *                 interpolação. `grep` é filtrado in-process (evita depender do
 *                 `-g`, ausente nos systemd antigos da frota) e tem length cap.
 *   - Bounded   : `since` obrigatório; `limit` default 500 / teto 5000; timeout
 *                 de spawn + teto de bytes matam processo fugitivo; --no-pager;
 *                 NUNCA -f/--follow.
 *   - Auth      : mesmas rotas passam pelo check X-API-Key do handler — logs
 *                 exigem a CENTRAL_API_KEY (sem allowInitialKey).
 */

const { spawn } = require('child_process');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const DEFAULT_ALLOWLIST = ['myio.service', 'myio-api.service'];
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;          // teto server-side
const GREP_MAX_LEN = 256;        // cap do padrão de busca
const SPAWN_TIMEOUT_MS = 15000;  // mata journalctl/systemctl pendurado
const MAX_STDOUT_BYTES = 8 * 1024 * 1024; // teto de saída (8 MiB)

// syslog: 0..7
const PRIORITY_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const PRIORITY_BY_NAME = {
  emerg: 0, alert: 1, crit: 2, err: 3, error: 3,
  warning: 4, warn: 4, notice: 5, info: 6, debug: 7,
};

function bad(msg) {
  return { error: true, statusCode: 400, body: { error: msg } };
}

/** Normaliza a allowlist vinda da config (array ou string separada por vírgula). */
function parseAllowlist(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const units = list.map((u) => String(u).trim()).filter(Boolean);
  return units.length ? units : DEFAULT_ALLOWLIST.slice();
}

/**
 * Valida a query do GET /logs contra a allowlist.
 * Retorna { error, ... } (400) ou os valores normalizados.
 */
function validateLogsQuery(req, allowlist) {
  const q = (req && req.query) || {};
  const units = allowlist && allowlist.length ? allowlist : DEFAULT_ALLOWLIST;

  const service = q.service;
  if (!service) return bad('service is required');
  if (!units.includes(service)) return bad('service not in allowlist');

  const since = q.since;
  if (!since || Number.isNaN(Date.parse(since))) return bad('since (ISO-8601 timestamp) is required');

  let until = null;
  if (q.until != null && q.until !== '') {
    if (Number.isNaN(Date.parse(q.until))) return bad('until must be an ISO-8601 timestamp');
    until = q.until;
  }

  let priority = 7; // debug = tudo
  if (q.priority != null && q.priority !== '') {
    const raw = String(q.priority).toLowerCase();
    priority = /^[0-7]$/.test(raw) ? parseInt(raw, 10) : PRIORITY_BY_NAME[raw];
    if (priority === undefined) return bad('priority must be emerg..debug or 0..7');
  }

  let grep = null;
  if (q.grep != null && q.grep !== '') {
    grep = String(q.grep);
    if (grep.length > GREP_MAX_LEN) return bad('grep pattern too long (max ' + GREP_MAX_LEN + ' chars)');
  }

  let limit = parseInt(q.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const order = String(q.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

  return { service, since, until, priority, grep, limit, order };
}

/**
 * Monta o argv do journalctl (exportado para os testes assertarem o array
 * exato). NUNCA inclui -f/--follow; a saída é sempre -o json --no-pager.
 */
function buildJournalctlArgs(v) {
  const args = [
    '-u', v.service,
    '--since', v.since,
  ];
  if (v.until) args.push('--until', v.until);
  args.push(
    '-p', String(v.priority),
    '-n', String(v.limit),
    '-o', 'json',
    '--no-pager'
  );
  if (v.order === 'desc') args.push('-r');
  return args;
}

/** 0..7 → nome syslog (fora da faixa → null). */
function priorityLevel(n) {
  return Number.isInteger(n) && n >= 0 && n <= 7 ? PRIORITY_NAMES[n] : null;
}

/** MESSAGE pode vir como array de bytes (payload binário) — normaliza p/ string. */
function journalMessage(m) {
  if (Array.isArray(m)) return Buffer.from(m).toString('utf8');
  return m == null ? '' : String(m);
}

/** Uma linha `journalctl -o json` → entry da resposta. */
function mapJournalLine(obj) {
  const us = Number(obj.__REALTIME_TIMESTAMP);
  const prio = obj.PRIORITY != null ? parseInt(obj.PRIORITY, 10) : null;
  const pid = obj._PID != null ? parseInt(obj._PID, 10) : null;
  return {
    ts: Number.isFinite(us) ? new Date(Math.floor(us / 1000)).toISOString() : null,
    priority: Number.isInteger(prio) ? prio : null,
    level: priorityLevel(prio),
    message: journalMessage(obj.MESSAGE),
    pid: Number.isInteger(pid) ? pid : null,
    unit: obj._SYSTEMD_UNIT || obj.UNIT || null,
  };
}

/**
 * Spawna um comando com timeout e teto de stdout; resolve com stdout (string).
 * Genérico de propósito (cmd + args) para ser testável sem journald.
 */
function boundedSpawn(cmd, args, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || SPAWN_TIMEOUT_MS;
  const maxBytes = (opts && opts.maxBytes) || MAX_STDOUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    let out = '';
    let errOut = '';
    let bytes = 0;
    let overflowed = false;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      out += chunk;
    });
    child.stderr.on('data', (chunk) => { if (errOut.length < 512) errOut += chunk; });
    child.on('error', (err) => reject(new Error(cmd + ': ' + err.message)));
    child.on('close', (code) => {
      if (overflowed) return reject(new Error(cmd + ': output exceeded ' + maxBytes + ' bytes'));
      if (code !== 0) {
        // mensagem curta — nunca o argv cru
        const detail = errOut.toString().trim().slice(0, 200);
        return reject(new Error(cmd + ' exited with code ' + code + (detail ? ': ' + detail : '')));
      }
      resolve(out);
    });
  });
}

/** Roda o journalctl e devolve as entries mapeadas (com grep in-process). */
async function readJournal(v, cfg) {
  const cmd = (cfg && cfg.journalctlPath) || 'journalctl';
  const stdout = await boundedSpawn(cmd, buildJournalctlArgs(v), cfg);
  const entries = [];
  let matcher = null;
  if (v.grep) {
    try {
      const re = new RegExp(v.grep, 'i');
      matcher = (msg) => re.test(msg);
    } catch (e) {
      const needle = v.grep.toLowerCase();
      matcher = (msg) => msg.toLowerCase().includes(needle);
    }
  }
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; } // linha não-JSON: ignora
    const entry = mapJournalLine(obj);
    if (matcher && !matcher(entry.message)) continue;
    entries.push(entry);
  }
  return entries;
}

/** Estado de uma unit via `systemctl show` (nunca enumeração ampla). */
async function serviceState(unit, cfg) {
  const cmd = (cfg && cfg.systemctlPath) || 'systemctl';
  try {
    const stdout = await boundedSpawn(
      cmd,
      ['show', unit, '-p', 'ActiveState,SubState,ActiveEnterTimestamp', '--no-pager'],
      cfg
    );
    const props = {};
    for (const line of stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    // "Mon 2026-08-10 20:12:31 UTC" → ISO (weekday fora, Date.parse resolve)
    let since = null;
    if (props.ActiveEnterTimestamp) {
      const parsed = Date.parse(props.ActiveEnterTimestamp.replace(/^[A-Za-z]{3}\s+/, ''));
      if (!Number.isNaN(parsed)) since = new Date(parsed).toISOString();
    }
    return {
      unit,
      active: props.ActiveState || 'unknown',
      sub: props.SubState || null,
      since,
    };
  } catch (err) {
    // unit ilegível/permissão faltando → degrada, não falha (RFC-0002)
    return { unit, active: 'unknown', sub: null, since: null };
  }
}

const logsEndpoints = [
  // ── GET /logs/services — allowlist + estado (para o picker do cockpit) ────
  {
    id: 'logsServices',
    method: 'get',
    path: '/logs/services',
    async exec(v, ctx) {
      const cfg = (ctx && ctx.logsConfig) || {};
      const units = parseAllowlist(cfg.allowlist);
      const services = await Promise.all(units.map((u) => serviceState(u, cfg)));
      return { payload: { services }, statusCode: 200, headers: JSON_HEADERS };
    },
  },

  // ── GET /logs — journal de UMA unit allowlisted, janela obrigatória ───────
  {
    id: 'logs',
    method: 'get',
    path: '/logs',
    validate(req, ctx) {
      const cfg = (ctx && ctx.logsConfig) || {};
      return validateLogsQuery(req, parseAllowlist(cfg.allowlist));
    },
    async exec(v, ctx) {
      const cfg = (ctx && ctx.logsConfig) || {};
      const entries = await readJournal(v, cfg);
      return {
        payload: {
          service: v.service,
          since: v.since,
          until: v.until || new Date().toISOString(),
          count: entries.length,
          entries,
        },
        statusCode: 200,
        headers: JSON_HEADERS,
      };
    },
  },
];

module.exports = {
  logsEndpoints,
  // internals exportados para teste
  validateLogsQuery, buildJournalctlArgs, mapJournalLine, parseAllowlist,
  boundedSpawn, priorityLevel,
  DEFAULT_ALLOWLIST, DEFAULT_LIMIT, MAX_LIMIT, GREP_MAX_LEN,
};
