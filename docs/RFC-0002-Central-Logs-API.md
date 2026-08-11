- Feature Name: `central-logs-api`
- Start Date: 2026-08-11
- RFC PR: (leave this empty)
- Tracking Issue: (leave this empty)

# Summary
[summary]: #summary

Add a set of **read-only HTTP endpoints** to `node-red-contrib-myio-api-flows`
that expose the **system / service logs** of a MYIO central — the `systemd`
journal of `myio.service`, `myio-api.service`, and a small allowlist of related
units — so on-call and a fleet log cockpit can read a central's logs remotely,
without SSH.

Unlike the telemetry endpoints (RFC-0001), which query PostgreSQL through the
declarative `validate → SQL → format` pipeline, log data lives in the **systemd
journal**, not the database. This RFC therefore introduces a second, clearly
bounded execution path: an **allowlisted, non-interactive `journalctl` read**.
It is `GET`-only, service-allowlisted, time- and size-bounded, and protected by
the module's `X-API-Key`.

# Motivation
[motivation]: #motivation

Today, reading a central's application/system logs requires **SSH into the box**
(`journalctl -u myio-api.service …`), which:

1. is manual and not automatable;
2. requires the Technical Lead's key (SSH to centrals is restricted); and
3. does not scale to a fleet — there is no way to pull "the last hour of errors
   from central X" from a dashboard.

There is an active need for exactly this: a **Central Logs cockpit** (Jira
ED-1107 "Painel de Centrais × Logs"; OKR "Cockpit de auditoria de logs das
aplicações") that centralizes each central's logs in one panel. That panel needs
a per-central HTTP source of journal logs. This RFC defines it, reusing the same
node, auth, and status plumbing api-flows already ships — so it deploys wherever
the node deploys.

Note the distinction from RFC-0001: RFC-0001 exposes **telemetry** (device
readings, incl. the `logs` hypertable of actuator events) from Postgres. This RFC
exposes **operational logs** (service stdout/stderr, systemd messages) from the
journal. They are different data in different stores.

# Guide-level explanation
[guide]: #guide-level-explanation

## The endpoints

Two `GET` endpoints, behind the node's base path (default `/api`):

```
GET {base}/logs/services
GET {base}/logs?service=&since=&until=&priority=&grep=&limit=&order=
```

### `GET {base}/logs/services`

Lists the units this node is **allowed** to read and their current state, so the
cockpit can render a picker without guessing:

```json
{
  "services": [
    { "unit": "myio-api.service", "active": "active",  "sub": "running", "since": "2026-08-10T20:12:31Z" },
    { "unit": "myio.service",     "active": "active",  "sub": "running", "since": "2026-08-10T20:12:29Z" },
    { "unit": "postgresql",       "active": "active",  "sub": "running", "since": "2026-08-10T20:12:10Z" }
  ]
}
```

### `GET {base}/logs`

Returns journal entries for **one allowlisted service** over a required time
window:

```
GET /api/logs?service=myio-api.service&since=2026-08-11T08:00:00Z&priority=warning&limit=500
X-API-Key: <key>
```

```json
{
  "service": "myio-api.service",
  "since": "2026-08-11T08:00:00Z",
  "until": "2026-08-11T09:00:00Z",
  "count": 2,
  "entries": [
    { "ts": "2026-08-11T08:41:12.004Z", "priority": 3, "level": "err",     "message": "pg pool error: connection timeout", "pid": 812, "unit": "myio-api.service" },
    { "ts": "2026-08-11T08:41:12.019Z", "priority": 4, "level": "warning", "message": "retrying in 5s",                     "pid": 812, "unit": "myio-api.service" }
  ]
}
```

### Query parameters

| Param      | Required | Default        | Notes                                                                 |
|------------|:--------:|----------------|-----------------------------------------------------------------------|
| `service`  | yes      | —              | Must be one of the configured **allowlist** units (else `400`).       |
| `since`    | yes      | —              | ISO-8601 lower bound. Required so a query can never dump the whole journal. |
| `until`    | no       | now            | ISO-8601 upper bound.                                                  |
| `priority` | no       | `debug` (all)  | Max syslog level to include: `emerg…debug` (or `0…7`). `warning` ⇒ ≤4. |
| `grep`     | no       | —              | Case-insensitive substring/regex match on the message (bounded).      |
| `limit`    | no       | `500`          | Capped at `5000` (see reference level).                               |
| `order`    | no       | `asc`          | `asc`/`desc` by timestamp.                                            |

A request MUST carry an allowlisted `service` **and** `since`. This guarantees
the read is scoped to one unit and time-bounded — a caller can never request
"everything".

# Reference-level explanation
[reference]: #reference-level-explanation

## Placement in the module

Log endpoints are declared in a new file `lib/logs.js` and concatenated onto the
node's endpoint array, exactly like `lib/telemetry.js` (RFC-0001). They ride the
same `makeHandler` route registration, `X-API-Key` auth, `node.status`, and
`close`/route-cleanup logic. Each is independently toggleable via
`config['ep_<id>'] !== false` with matching checkboxes in the HTML.

**They do NOT use the `myio-pg` Postgres pool.** The handler for a log endpoint
does not run SQL; it spawns a bounded `journalctl` process (below). This is the
one deliberate departure from RFC-0001's SQL-only model, isolated to `lib/logs.js`.

## Reading the journal (bounded, no shell)

The endpoint runs `journalctl` via `child_process.spawn` with an **argument
array** (never a shell string — no interpolation, no injection), reading
machine-readable JSON:

```js
const args = [
  '-u', service,                    // service is validated against the allowlist first
  '--since', sinceIso,              // ISO passed straight to journalctl
  '--until', untilIso,
  '-p', priorityToken,              // 0..7
  '-n', String(cappedLimit),        // hard cap
  '-o', 'json',                     // one JSON object per line
  '--no-pager',
];
// NEVER pass -f/--follow (would hang). Reverse for order=desc.
const child = spawn(journalctlPath, args, { timeout: SPAWN_TIMEOUT_MS });
```

Each stdout line is a JSON object; the handler maps the fields it needs:

| journal field       | response field | notes                              |
|---------------------|----------------|------------------------------------|
| `__REALTIME_TIMESTAMP` | `ts`        | microseconds since epoch → ISO-8601 |
| `PRIORITY`          | `priority`/`level` | 0..7 → syslog level name        |
| `MESSAGE`           | `message`      | if `grep` set, filtered here or via `-g` |
| `_PID`              | `pid`          |                                    |
| `_SYSTEMD_UNIT`     | `unit`         |                                    |

`grep` maps to `journalctl -g <pattern>` (or is applied in-process); `order=desc`
uses `-r`. `GET /logs/services` runs
`systemctl show <unit> -p ActiveState,SubState,ActiveEnterTimestamp` per
allowlisted unit (or `journalctl --no-pager -n0`), never a broad enumeration.

## Guarantees

- **Allowlist only.** `service` must exactly match a configured unit
  (default `myio.service`, `myio-api.service`; optional `postgresql`,
  `nodered`). Anything else ⇒ `400`. There is no way to read an arbitrary unit,
  the whole journal (`journalctl` with no `-u`), or kernel/dmesg.
- **No shell / no injection.** Args are an array; `service` is allowlisted;
  `since`/`until` are validated as ISO-8601; `priority` is mapped to `0..7`;
  `grep` is passed as a single arg (and length-capped).
- **Bounded output.** `limit` hard-capped at `5000`; `--since` is required;
  a `spawn` **timeout** and a **max-bytes** guard kill a runaway process; the
  process is `--no-pager` and never `--follow`.
- **Read-only, authenticated.** `GET` only; subject to `X-API-Key` (missing/invalid
  ⇒ `401` before spawning anything).

## Response, status, errors

- `200` with `{ service, since, until, count, entries[] }`.
- `node.status` shows `logs myio-api · N`, or the failure (red) with the exit code.
- `journalctl` exit ≠ 0 or spawn error ⇒ `500` with a short message (never the raw
  argv). Unknown/blocked `service` ⇒ `400`. Missing key ⇒ `401`.

## Configuration (config node / node)

- **Allowlisted units** — a config field (default `myio.service,myio-api.service`),
  so an operator can broaden/narrow per deployment.
- **`journalctl` path** — default `journalctl` (PATH), overridable.
- **Caps** — default `limit` (500) and hard cap (5000), spawn timeout, max bytes.

## Permissions (the load-bearing caveat)

`myio-api.service` (which hosts Node-RED) must be able to **read the journal of
the target units**. On MYIO images the service may run under a restricted user
(e.g. `DynamicUser`), which by default can read **its own** unit's journal but
**not** other units'. Reading `myio.service`/`postgresql` from within
`myio-api.service` therefore requires one of:

- adding the service user to the **`systemd-journal`** group (read-all), or
- `journalctl` with the appropriate capability, or
- a narrow sudoers rule for the exact `journalctl -u <allowlisted>` invocation.

This is a **deployment prerequisite**, documented here and validated by
`GET /logs/services` (a unit it cannot read is reported with `active: "unknown"`).

## Testing

`test/logs.test.js` (no real journal): validate parameter handling (allowlist
rejection, required `since`, `limit` cap, priority mapping, `order`), the argv
**builder** (asserts the exact `journalctl` args and that no shell string is
ever constructed), and the journal-JSON→entry mapper (timestamp/priority
conversion). These join the existing `test/endpoints.test.js`,
`test/telemetry.test.js` (if present), and `test/auth.test.js`.

# Drawbacks
[drawbacks]: #drawbacks

- **A second execution model.** api-flows was "declarative SQL over Postgres".
  This adds a `child_process.spawn` path. It is isolated to `lib/logs.js` and
  tightly bounded, but it is genuinely different and widens the module's surface.
- **Permission prerequisite.** Reading other units' journals needs a deployment
  step (`systemd-journal` group / sudoers). Without it, only `myio-api.service`
  is readable — the endpoint degrades but does not fail dangerously.
- **Exec cost.** Each request forks `journalctl`; a busy cockpit adds process
  churn on a weak ARM board. Mitigated by the auth gate, the `limit` cap, and the
  spawn timeout.
- **Not structured app logs.** Journal messages are free text; there is no schema
  beyond syslog priority. Rich querying (per-request tracing) is out of scope.

# Rationale and alternatives
[rationale]: #rationale-and-alternatives

- **`journalctl -o json` vs reading files.** The journal is the system of record
  for service logs on these images; `-o json` gives structured fields
  (timestamp, priority, unit, pid) without parsing ad-hoc log formats. Tailing
  `/var/log/*` would be fragile and image-specific.
- **Allowlist + required `since` vs open query.** The cheapest way to guarantee a
  read is scoped and bounded; an open `journalctl` could dump gigabytes or hang.
- **Reuse the api-flows node** vs a new service or a bespoke Node-RED tab: same
  auth/status/deploy story, one place to secure, ships with the node.
- **Do nothing.** Leaves logs reachable only via privileged SSH — not automatable,
  and blocks the logs cockpit (ED-1107).

# Prior art
[prior-art]: #prior-art

- **RFC-0001 (Telemetry Query API)** — the sibling read API and the declarative
  endpoint/auth/status pattern this RFC extends (with the SQL path swapped for a
  bounded `journalctl` read).
- The module's `X-API-Key` middleware — the authentication reused here.
- `systemd` `journalctl -o json` / `-o json-seq` — the standard machine-readable
  journal interface.
- Fleet log/observability cockpits — centralizing per-node logs behind one panel
  (Jira ED-1107; OKR "Cockpit de auditoria de logs das aplicações").

# Unresolved questions
[unresolved]: #unresolved-questions

- **Default allowlist.** Just `myio.service` + `myio-api.service`, or also
  `postgresql`, `nodered`, and the backup/collector units?
- **Permission model.** `systemd-journal` group vs a scoped sudoers rule vs a
  capability — which does the MYIO image ship, and is it set at provisioning?
- **Streaming/tail.** Should there be a follow/SSE variant for live tail, or is
  windowed pull enough for the cockpit? (`--follow` is explicitly excluded from
  the windowed endpoint.)
- **Redaction.** Do any service logs contain secrets/PII that must be scrubbed
  before leaving the box (e.g. tokens in error messages)?
- **Rate limiting.** Per-key/per-central request caps to protect the ARM board
  from cockpit polling?

# Future possibilities
[future]: #future-possibilities

- **Live tail** via SSE/WebSocket (`journalctl -f`) with a hard idle timeout.
- **Boot/health summary** endpoint (last boot, restarts, OOMs, failed units).
- **Severity rollups** (`count by priority` over a window) to power a fleet
  "errors per central" heat view without shipping raw lines.
- **CSV/NDJSON export** for offline analysis.
- **Cross-source correlation** with the telemetry `logs` hypertable (RFC-0001)
  so a device event and the service log around it can be viewed together.
- **Central-side redaction filters** applied before the response leaves the box.
