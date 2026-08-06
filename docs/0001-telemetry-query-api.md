- Feature Name: `telemetry-query-api`
- Start Date: 2026-08-05
- RFC PR: (leave this empty)
- Tracking Issue: (leave this empty)

# Summary
[summary]: #summary

Add a set of **read-only HTTP endpoints** to `node-red-contrib-myio-api-flows`
that expose the time-series **telemetry** stored locally on a MYIO central
(OrangePi / CM4, PostgreSQL + TimescaleDB) through the same declarative
`validate → SQL → format` pipeline already used by the module.

Telemetry on a central is not a single table: it is routed **by device type**
across `consumption_realtime` (energy), `channel_pulse_log` (pulse/water),
`logs` (actuators), and `temperature_history` (temperature). This RFC defines
one bounded, index-friendly, key-protected `GET` endpoint per source, so a
consumer can pull raw readings for a given `slave_id` (and optional `channel`)
over a required time window, without opening direct database access to the
central.

# Motivation
[motivation]: #motivation

Today the module exposes cadastro/state and MQTT-sync control
(`GET /state`, `GET /mqttSyncStatus`, `POST /provision`, `POST /clearAllData`,
`POST /setMqttSyncStatus`). There is **no supported way to read the actual
telemetry** a central collects. Consumers that need historical readings must
either:

1. SSH into the central and run `psql` by hand (operator-only, not automatable,
   requires the Technical Lead's key), or
2. Wait for the data to propagate upstream (ThingsBoard / GCDR), which is not
   available when debugging the edge in isolation and does not reflect the
   central's own raw rows.

We want a first-class, automatable, **auditable** way to answer questions like
"what did slave 47 report between 08:00 and 09:00?" directly against the edge,
reusing the existing node instead of standing up a new service or a bespoke
Node-RED tab per central.

Constraints that shape the design:

- The central is a **small ARM board**. A naive query can scan an entire
  TimescaleDB hypertable and starve the box. Every endpoint MUST be bounded.
- Telemetry is **sensitive**; the endpoints MUST be protected by the module's
  `X-API-Key` mechanism (see the auth RFC / PR).
- Storage is **version-fragmented** across image generations (TimescaleDB
  `1.7.5` on the old Poky image vs `2.18.0` on CM4). The endpoints MUST rely
  only on stable, user-facing columns — never on TimescaleDB internal catalogs.

# Guide-level explanation
[guide]: #guide-level-explanation

## Where telemetry lives

A MYIO central stores readings in the local `hubot` database, routed by the
kind of device that produced them:

| Device type                     | Table                  | Key columns                                             | Hypertable |
|---------------------------------|------------------------|---------------------------------------------------------|:----------:|
| Energy (3-phase / meter)        | `consumption_realtime` | `timestamp, slave_id, value, value_reactive`            | yes        |
| Pulse (water meter / pulse kWh) | `channel_pulse_log`    | `timestamp, slave_id, channel, value, reading`          | yes        |
| Actuator (plug / lamp / relay)  | `logs`                 | `timestamp, slave_id, channel, type, action_type, "user", value` | yes |
| Temperature                     | `temperature_history`  | `timestamp, slave_id, value`                            | no         |
| Raw energy                      | `raw_energy`           | `value, datetime (epoch int), slave_id`                 | no         |
| Aggregated consumption          | `consumption`          | `timestamp, slave_id, ambient_id, value, type`          | no         |

Note the shape differences that a consumer must understand:

- `consumption_realtime` is **per slave** — it has **no `channel`** column.
- `channel_pulse_log`, `logs` are **per (slave, channel)**.
- In `logs`, an actuator's state is `value = 100` (on) / `0` (off), split into
  `type = 'binary_sensor'` (device feedback) and
  `type = 'user_action'`/`action_type = 'activate_channel'` (who commanded it).
- `raw_energy.datetime` is an **epoch integer**, not a `timestamptz`.

## The endpoints

This RFC adds four `GET` endpoints (behind the node's base path, default
`/api`), one per primary telemetry source:

```
GET {base}/telemetry/pulses       ?slave_id=&channel=&from=&to=&limit=&order=
GET {base}/telemetry/energy       ?slave_id=&from=&to=&limit=&order=
GET {base}/telemetry/actuator     ?slave_id=&channel=&from=&to=&limit=&order=
GET {base}/telemetry/temperature  ?slave_id=&from=&to=&limit=&order=
```

Two optional endpoints (off by default) cover the non-hypertable sources:

```
GET {base}/telemetry/raw-energy   ?slave_id=&from=&to=&limit=&order=
GET {base}/telemetry/consumption  ?slave_id=&ambient_id=&type=&from=&to=&limit=&order=
```

### Query parameters

| Param        | Required | Default        | Notes                                                        |
|--------------|:--------:|----------------|--------------------------------------------------------------|
| `slave_id`   | yes\*    | —              | Integer. \*`consumption` may take `ambient_id` instead.      |
| `channel`    | no       | (all channels) | Integer; only where the table has `channel`.                 |
| `from`       | yes      | —              | ISO-8601 timestamp; lower bound (inclusive).                 |
| `to`         | no       | `now()`        | ISO-8601 timestamp; upper bound (inclusive).                 |
| `limit`      | no       | `500`          | Capped at `5000` (see reference level).                      |
| `order`      | no       | `desc`         | `asc` or `desc` on `timestamp`.                              |

A request MUST carry both a **row selector** (`slave_id`, or `ambient_id` for
`consumption`) and a **lower time bound** (`from`). This guarantees the query
uses the existing composite index and never full-scans a hypertable.

### Example

```
GET /api/telemetry/energy?slave_id=12&from=2026-08-05T08:00:00Z&to=2026-08-05T09:00:00Z&limit=200
X-API-Key: <key>
```

```json
{
  "source": "consumption_realtime",
  "slave_id": 12,
  "count": 2,
  "rows": [
    { "timestamp": "2026-08-05T08:59:30Z", "slave_id": 12, "value": 4213.5, "value_reactive": 118.2 },
    { "timestamp": "2026-08-05T08:59:00Z", "slave_id": 12, "value": 4213.1, "value_reactive": 118.0 }
  ]
}
```

Errors are the module's existing JSON shape: `400` for a bad/missing parameter,
`401` for a missing/invalid `X-API-Key`, `500` for an unexpected DB error.

# Reference-level explanation
[reference]: #reference-level-explanation

## Placement in the module

The endpoints are declared in a new file `lib/telemetry.js` that exports an
array of endpoint descriptors in the exact shape consumed by
`myio-api-flows.js` today (`{ id, method, path, sql, validate, format }`).
`lib/endpoints.js` (or the main node) concatenates
`require('./lib/telemetry').telemetryEndpoints` onto its `endpoints` array.
No change to the handler, the pool, or the route-registration/close logic is
required — telemetry endpoints ride the same `makeHandler` path.

Each endpoint is independently toggleable via the same
`config['ep_<id>'] !== false` convention, with matching checkboxes in
`myio-api-flows.html`. The two non-hypertable endpoints
(`telemetryRawEnergy`, `telemetryConsumption`) default to **off**.

## Parameter validation and binding

`validate(req)` parses `req.query`, enforces the rules, and returns
`{ params: [...] }` (bound `$1..$n`) or `{ error, statusCode, body }`. All
values reach SQL **only** as bind parameters — never string-interpolated — so
there is no SQL-injection surface. The one exception, `order`, is not a bind
parameter; it is validated against the allowlist `{asc, desc}` and mapped to a
literal `ASC`/`DESC` fragment (default `DESC`).

```js
function parseCommon(req, { hasChannel }) {
  const slave = parseInt(req.query.slave_id, 10);
  if (!Number.isInteger(slave)) {
    return { error: true, statusCode: 400, body: { error: 'slave_id (integer) is required' } };
  }
  const from = req.query.from;
  if (!from || Number.isNaN(Date.parse(from))) {
    return { error: true, statusCode: 400, body: { error: 'from (ISO-8601 timestamp) is required' } };
  }
  const to = req.query.to && !Number.isNaN(Date.parse(req.query.to)) ? req.query.to : null; // null → now()
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = 500;
  limit = Math.min(limit, 5000); // hard cap protects the ARM board
  const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let channel = null;
  if (hasChannel && req.query.channel != null && req.query.channel !== '') {
    channel = parseInt(req.query.channel, 10);
    if (!Number.isInteger(channel)) {
      return { error: true, statusCode: 400, body: { error: 'channel must be an integer when provided' } };
    }
  }
  return { slave, from, to, limit, order, channel };
}
```

## SQL per endpoint

`to` defaults to `now()` in SQL when the bound parameter is `NULL`
(`COALESCE($3::timestamptz, now())`), so the caller can omit it.

`telemetry/energy` — `consumption_realtime` (per slave, uses
`(slave_id, timestamp)` index):

```sql
SELECT timestamp, slave_id, value, value_reactive
FROM consumption_realtime
WHERE slave_id = $1
  AND timestamp >= $2
  AND timestamp <= COALESCE($3::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $4;
```

`telemetry/pulses` — `channel_pulse_log` (uses
`(slave_id, channel, timestamp DESC)` index; `channel` optional):

```sql
SELECT timestamp, slave_id, channel, value, reading
FROM channel_pulse_log
WHERE slave_id = $1
  AND ($2::int IS NULL OR channel = $2)
  AND timestamp >= $3
  AND timestamp <= COALESCE($4::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $5;
```

`telemetry/actuator` — `logs` (plug/lamp/relay state and commands):

```sql
SELECT timestamp, slave_id, channel, type, action_type, "user", value
FROM logs
WHERE slave_id = $1
  AND ($2::int IS NULL OR channel = $2)
  AND timestamp >= $3
  AND timestamp <= COALESCE($4::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $5;
```

`telemetry/temperature` — `temperature_history`:

```sql
SELECT timestamp, slave_id, value
FROM temperature_history
WHERE slave_id = $1
  AND timestamp >= $2
  AND timestamp <= COALESCE($3::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $4;
```

`telemetry/raw-energy` — `raw_energy` (epoch `datetime`, converted on output;
the window is bound in epoch seconds so the comparison stays on the raw column):

```sql
SELECT id, slave_id, value,
       datetime AS datetime_epoch,
       to_timestamp(datetime) AS timestamp
FROM raw_energy
WHERE slave_id = $1
  AND datetime >= extract(epoch FROM $2::timestamptz)
  AND datetime <= extract(epoch FROM COALESCE($3::timestamptz, now()))
ORDER BY datetime {ORDER}
LIMIT $4;
```

`telemetry/consumption` — `consumption` (aggregated; accepts `slave_id` or
`ambient_id`, optional `type`):

```sql
SELECT id, timestamp, slave_id, ambient_id, value, type
FROM consumption
WHERE ($1::int IS NULL OR slave_id = $1)
  AND ($2::int IS NULL OR ambient_id = $2)
  AND ($3::text IS NULL OR type = $3::enum_consumption_type)
  AND timestamp >= $4
  AND timestamp <= COALESCE($5::timestamptz, now())
ORDER BY timestamp {ORDER}
LIMIT $6;
```

For `consumption`, at least one of `slave_id`/`ambient_id` MUST be present;
`validate` rejects the request otherwise.

## Response shape

`format(rows, ctx)` returns:

```js
{ payload: { source: '<table>', slave_id: <n|null>, count: rows.length, rows }, statusCode: 200 }
```

Timestamps serialize as ISO-8601 (pg returns `Date`; JSON stringify yields
ISO). `raw-energy` additionally carries `datetime_epoch` for callers that want
the original integer.

## Performance and safety guarantees

- **Bounded**: required `slave_id`/`ambient_id` + required `from` ⇒ every query
  is anchored on the leading index column and time-bounded; no unbounded
  hypertable scan is expressible through the API.
- **Capped**: `limit` is hard-capped at `5000` server-side regardless of the
  requested value.
- **Read-only**: only `GET`; no endpoint writes.
- **Authenticated**: subject to the module's `X-API-Key` check (missing/invalid
  key ⇒ `401` before any SQL runs).
- **Version-safe**: queries touch only stable user columns, so they work
  identically on TimescaleDB `1.7.5` and `2.18.0` (no internal-catalog access,
  no compression-specific SQL).

## Keyset pagination (optional, additive)

To page beyond `limit` without `OFFSET` (which degrades on large hypertables),
each endpoint MAY accept a `before`/`after` cursor bound to `timestamp` (and a
tiebreaker `id` where available), translating to
`AND timestamp < $cursor` for `order=desc`. This is specified as a
**future possibility**, not part of the initial surface.

## Testing

`test/telemetry.test.js` exercises `validate` in isolation (no DB): required
params, the `limit` cap, the `order` allowlist, optional-`channel` handling,
and the `consumption` selector rule. SQL strings are asserted to contain the
expected table, the `$1..$n` placeholders, and the bounded `WHERE`. These join
the existing `test/endpoints.test.js` and `test/auth.test.js` in the `test`
script.

# Drawbacks
[drawbacks]: #drawbacks

- **Surface growth.** Six new endpoints enlarge the node's API and its config
  UI. Mitigated by per-endpoint toggles and defaulting the niche ones off.
- **Schema coupling.** The SQL hard-codes column names of central tables. A
  future central schema change would require a module update. Mitigated by
  relying only on the documented, long-stable columns.
- **Read amplification risk.** Even bounded queries can return up to 5000 rows
  from a fast board; a busy caller could add load. Mitigated by the cap and by
  the endpoints being authenticated and operator-enabled.
- **Not a metrics layer.** Returning raw rows is not the same as downsampled or
  aggregated series; heavy analytical use over HTTP is discouraged.

# Rationale and alternatives
[rationale]: #rationale-and-alternatives

- **One endpoint per source vs a single `/telemetry?type=` dispatcher.**
  Per-source endpoints keep each `validate`/`sql`/`format` small, make the
  differing columns (e.g. `consumption_realtime` has no `channel`) explicit,
  and let operators toggle each independently. A single dispatcher would push
  type-branching into one handler and blur the response schema.
- **Mandatory `slave_id` + `from`.** The cheapest way to guarantee index use on
  a weak board. An alternative — allowing open-ended queries with a global cap —
  was rejected because a `LIMIT`-only guard still forces a scan when the
  predicate is not selective.
- **Reuse the declarative pipeline** instead of a new service or per-central
  Node-RED tab: zero new runtime, consistent auth/status/close behavior, and
  the endpoints ship wherever the node ships.
- **Do nothing.** Leaves telemetry reachable only via manual `psql`, which is
  not automatable and requires privileged SSH access.

# Prior art
[prior-art]: #prior-art

- The module's existing declarative endpoints (`GET /state`,
  `GET /mqttSyncStatus`, `POST /provision`, …) established the
  `validate → SQL → format` pattern this RFC extends.
- The `X-API-Key` middleware RFC/PR established the authentication this RFC
  depends on.
- The central data model is documented in the main library repo:
  `src/NODE-RED/GLOBAL_INFO/data-model-postgres-timeseries.md` (telemetry
  routing by device type, §3.6) and
  `src/NODE-RED/GLOBAL_INFO/manual-centrais-linix-orangepi.md` (operations).
- TimescaleDB hypertables + composite `(entity, timestamp)` indexes are the
  standard access pattern for time-bounded reads.

# Unresolved questions
[unresolved]: #unresolved-questions

- Should the default `limit` (500) and hard cap (5000) be **configurable per
  node** rather than constants?
- Should `slave_id` accept a **list** (e.g. `slave_id=12,13,14`) for batch
  reads, or is single-slave sufficient for the driving use cases?
- Should there be a **server-side aggregation** variant (e.g. TimescaleDB
  `time_bucket`) for energy/temperature, or does that belong upstream (GCDR)?
- What is the maximum acceptable window a single request may span before the
  API should reject it outright (independent of `limit`)?

# Future possibilities
[future]: #future-possibilities

- **Keyset pagination** (`before`/`after` cursor) for large windows.
- **`time_bucket` rollup** endpoints (avg/min/max/sum per interval) to move
  common downsampling to the edge.
- **CSV output** (`Accept: text/csv` or `?format=csv`) for direct export,
  mirroring report tooling.
- **A "latest" convenience endpoint** (`DISTINCT ON (slave_id)`), returning the
  most recent reading per slave without a time window.
- **Unifying the raw-energy epoch quirk** behind a normalized `timestamp` field
  so all telemetry endpoints share an identical envelope.
