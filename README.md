# node-red-contrib-myio-api-flows

A single Node-RED node that **encapsulates the entire "API flow"** of MYIO
centrals — today spread across an `API` tab with dozens of nodes (`http-in` +
`function` + `postgresql` + `http-response`, ×5 endpoints). In the spirit of
[`node-red-contrib-myio-data-fetcher`](https://github.com/gh-myio/node-red-contrib-myio-data-fetcher).

## What it does

On Deploy, the node **registers the HTTP routes** on the Node-RED server
(`RED.httpNode`) and, on each request, runs `validate → SQL → format` against
the central's Postgres (`hubot`) — using the functions installed by the
`mqtt-sync`/state-api kit.

| Route (under the base path, default `/api`) | Database function | Notes |
|---|---|---|
| `GET  /api/mqttSyncStatus` | `get_mqtt_sync_status()` | precedence db → cache → `enable` |
| `GET  /api/state` | `json_build_object(...)` | snapshot of ambients/slaves/channels/rfir/rels/environment (API keys excluded) |
| `POST /api/clearAllData` | `clear_all_data_central()` | ⚠️ **destructive** (wipes registration data) |
| `POST /api/provision` | `provision_central($1::jsonb)` | `devices[]` (`207` if `result.errors[]`) **or** `environment{}` (key→value upsert) |
| `POST /api/setMqttSyncStatus` | `set_mqtt_sync_status($1::jsonb)` | validates the v2 envelope (`intent`/`mqttSyncStatus`) |

The `mqttSyncStatus` value is cached in Node-RED's `global` context (same as the
original flow), kept consistent between `GET` and `POST /setMqttSyncStatus`.

## Telemetry Query API (RFC-0001)

Read-only `GET` endpoints over the telemetry stored locally on the central
(see `docs/RFC-0001-Telemetry-Query-API.md`). Query string:
`?slave_id=&from=&to=&limit=&order=` — `slave_id` and `from` (ISO-8601) are
**required** (guarantees index-anchored, time-bounded queries on the ARM
board), `limit` defaults to 500 and is hard-capped at 5000, `order` is
`asc|desc` (default `desc`).

| Route | Source table | Notes |
|---|---|---|
| `GET /api/telemetry/energy` | `consumption_realtime` | per slave (no `channel`) |
| `GET /api/telemetry/pulses` | `channel_pulse_log` | optional `channel` |
| `GET /api/telemetry/actuator` | `logs` | optional `channel`; state + commands |
| `GET /api/telemetry/temperature` | `temperature_history` | |
| `GET /api/telemetry/raw-energy` | `raw_energy` | epoch `datetime`; **off by default** |
| `GET /api/telemetry/consumption` | `consumption` | `slave_id` **or** `ambient_id`; **off by default** |

Response envelope: `{ source, slave_id, count, rows }`. Telemetry routes
require the `CENTRAL_API_KEY` (the initial key is not accepted).

## Central Logs API (RFC-0002)

Read-only `GET` endpoints over the central's **systemd journal** (see
`docs/RFC-0002-Central-Logs-API.md`) — no more SSH to read service logs.
Unlike the SQL endpoints, these spawn a bounded, allowlisted `journalctl`
(argument array, never a shell; `-o json --no-pager`, never `--follow`).

| Route | Notes |
|---|---|
| `GET /api/logs/services` | allowlisted units + state (`active`/`sub`/`since`) |
| `GET /api/logs?service=&since=&until=&priority=&grep=&limit=&order=` | journal of **one** allowlisted unit |

`service` (allowlisted; default `myio.service,myio-api.service`, configurable
in the editor) and `since` (ISO-8601) are **required**; `priority` is
`emerg…debug`/`0..7`; `grep` is filtered in-process (length-capped); `limit`
defaults to 500, hard-capped at 5000; spawn timeout + output cap kill runaway
reads. Response: `{ service, since, until, count, entries[] }` with
`entries[] = { ts, priority, level, message, pid, unit }`. Requires the
`CENTRAL_API_KEY`.

> **Deployment prerequisite:** the service hosting Node-RED must be able to
> read the target units' journals (e.g. `systemd-journal` group). An unreadable
> unit shows up as `active: "unknown"` in `/logs/services`.

## Auth — X-API-Key (ED-1096 / RFC-0056)

Routes require the `X-API-Key` header, validated against keys that live in the
central database's `environment` table (**read on every request** — rotate with
an `UPDATE`, no redeploy). No key registered → routes stay open
(backwards-compatible).

| Key | Where it lives | Scope |
|---|---|---|
| `CENTRAL_PRE_INITIAL_API_KEY` | hardcoded in `lib/endpoints.js` (whole fleet) | GCDR bootstrap only — authenticates no route |
| `CENTRAL_INITIAL_API_KEY` | `environment` table (obtained from GCDR on deploy) | `GET /state` and `POST /provision` restricted to `environment{}` |
| `CENTRAL_API_KEY` | `environment` table | all 5 routes |

**Bootstrap (TOFU):** on deploy the node calls
`GET {GCDR}/public/central/initial-key` (headers `X-Central-Pre-Key` + the
central's `uuid`), stores the returned `CENTRAL_INITIAL_API_KEY` in the
`environment` table and re-syncs once a day. Pre-setup then uses that key in
`POST /provision {"environment":{"CENTRAL_API_KEY":"..."}}` to store the
definitive key. `devices[]` with the initial key → `403`.

`GET /state` **never echoes** the `CENTRAL_API_KEY`/`CENTRAL_INITIAL_API_KEY`
rows in the snapshot's `environment` object — the API never returns a secret
(prevents initial → full escalation and exposure while routes are open).

## Install

```bash
cd ~/.node-red   # (or the central's active userDir)
npm install node-red-contrib-myio-api-flows
```
Requires `pg@8.13.3` (declared dependency) and the database functions already
installed (`get_mqtt_sync_status`, `set_mqtt_sync_status`, `provision_central`,
`clear_all_data_central` — see the `mqtt-sync/` kit in the `myio-js-library`
repo).

## Usage

1. Drag the **`myio api flows`** node (MYIO category) into the flow.
2. Create/select a **Postgres (`myio-pg`)** config node: host, port, database
   (`hubot`), user, password (may be empty with local `trust`/`peer` auth).
3. Adjust the **base path** (default `/api`) and toggle endpoints on/off.
4. (Optional) Fill in **Central UUID** and **GCDR URL** for the
   `CENTRAL_INITIAL_API_KEY` bootstrap — left empty, the node reads the uuid
   from the `environment` table rows `CENTRAL_UUID`/`uuid` and uses the
   production GCDR.
5. Deploy. The routes start responding at `http://<central>:8080/api/...`.

> Redeploy removes and re-registers only this node's routes (no duplicates).

## Config node `myio-pg`

A `pg` pool shared by the nodes that reference it. Closed on `close`.

## Dev

- `myio-api-flows.js` — runtime (config node + main node + route registration + GCDR bootstrap)
- `lib/endpoints.js` — declarative definition of the 5 endpoints (SQL + validate + format) + key constants
- `lib/auth.js` — X-API-Key validation (time-constant comparison, per-route key set)
- `lib/gcdr.js` — initial key bootstrap against GCDR (RFC-0056)
- `lib/telemetry.js` — telemetry endpoints (RFC-0001): bounded/capped GET queries
- `lib/logs.js` — logs endpoints (RFC-0002): allowlisted, bounded `journalctl` reads
- `myio-api-flows.html` — editor

## License

MIT
