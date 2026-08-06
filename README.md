# node-red-contrib-myio-api-flows

Um único node Node-RED que **encapsula todo o "flow API"** das centrais MYIO —
hoje espalhado numa aba `API` com dezenas de nós (`http-in` + `function` +
`postgresql` + `http-response`, ×5 endpoints). No espírito do
[`node-red-contrib-myio-data-fetcher`](https://github.com/gh-myio/node-red-contrib-myio-data-fetcher).

## O que faz

Ao dar Deploy, o node **sobe as rotas HTTP** no servidor do Node-RED
(`RED.httpNode`) e, a cada request, executa `validate → SQL → format` contra o
Postgres (`hubot`) da central — usando as funções instaladas pelo kit
`mqtt-sync`/state-api.

| Rota (sob o base path, default `/api`) | Função no banco | Notas |
|---|---|---|
| `GET  /api/mqttSyncStatus` | `get_mqtt_sync_status()` | precedência db → cache → `enable` |
| `GET  /api/state` | `json_build_object(...)` | snapshot ambients/slaves/channels/rfir/rels/environment (sem as API keys) |
| `POST /api/clearAllData` | `clear_all_data_central()` | ⚠️ **destrutivo** (apaga cadastro) |
| `POST /api/provision` | `provision_central($1::jsonb)` | `devices[]` (`207` se `result.errors[]`) **ou** `environment{}` (upsert key→value) |
| `POST /api/setMqttSyncStatus` | `set_mqtt_sync_status($1::jsonb)` | valida envelope v2 (`intent`/`mqttSyncStatus`) |

O status `mqttSyncStatus` é mantido em cache no `global` do Node-RED (igual ao
flow original), coerente entre o `GET` e o `POST /setMqttSyncStatus`.

## Auth — X-API-Key (ED-1096 / RFC-0056)

As rotas exigem o header `X-API-Key`, validado contra keys que vivem na tabela
`environment` do banco da central (**lidas a cada request** — rotação por
`UPDATE`, sem redeploy). Sem key cadastrada → rotas abertas (retrocompatível).

| Key | Onde vive | Escopo |
|---|---|---|
| `CENTRAL_PRE_INITIAL_API_KEY` | hardcoded em `lib/endpoints.js` (frota toda) | só o bootstrap no GCDR — não autentica rota |
| `CENTRAL_INITIAL_API_KEY` | tabela `environment` (obtida do GCDR no deploy) | `GET /state` e `POST /provision` restrito a `environment{}` |
| `CENTRAL_API_KEY` | tabela `environment` | todas as 5 rotas |

**Bootstrap (TOFU):** no deploy o node chama
`GET {GCDR}/public/central/initial-key` (headers `X-Central-Pre-Key` + `uuid`
da central), grava a `CENTRAL_INITIAL_API_KEY` retornada na `environment` e
re-sincroniza 1×/dia. O pre-setup então usa essa key em
`POST /provision {"environment":{"CENTRAL_API_KEY":"..."}}` para gravar a key
definitiva. `devices[]` com a initial key → `403`.

O `GET /state` **não ecoa** as rows `CENTRAL_API_KEY`/`CENTRAL_INITIAL_API_KEY`
no objeto `environment` do snapshot — a API nunca devolve segredo (evita
escalação initial → full e exposição enquanto as rotas estão abertas).

## Instalação

```bash
cd ~/.node-red   # (ou o userDir ativo da central)
npm install node-red-contrib-myio-api-flows
```
Requer `pg@8.13.3` (dependência declarada) e as funções do banco já instaladas
(`get_mqtt_sync_status`, `set_mqtt_sync_status`, `provision_central`,
`clear_all_data_central` — ver kit `mqtt-sync/` no repo `myio-js-library`).

## Uso

1. Arraste o node **`myio api flows`** (categoria MYIO) para o flow.
2. Crie/selecione um config node **Postgres (`myio-pg`)**: host, porta, banco
   (`hubot`), usuário, senha (pode ser vazia com auth `trust`/`peer` local).
3. Ajuste o **base path** (default `/api`) e ligue/desligue endpoints.
4. (Opcional) Preencha **UUID central** e **GCDR URL** para o bootstrap da
   `CENTRAL_INITIAL_API_KEY` — vazios, o node lê o uuid das rows
   `CENTRAL_UUID`/`uuid` da tabela `environment` e usa o GCDR de produção.
5. Deploy. As rotas passam a responder em `http://<central>:8080/api/...`.

> Redeploy remove e re-registra apenas as rotas deste node (sem duplicar).

## Config node `myio-pg`

Um pool `pg` compartilhado entre os nodes que o referenciam. Fecha no `close`.

## Dev

- `myio-api-flows.js` — runtime (config node + node principal + registro de rotas + bootstrap GCDR)
- `lib/endpoints.js` — definição declarativa dos 5 endpoints (SQL + validate + format) + constantes das keys
- `lib/auth.js` — validação X-API-Key (comparação time-constant, conjunto de keys por rota)
- `lib/gcdr.js` — bootstrap da initial key no GCDR (RFC-0056)
- `myio-api-flows.html` — editor

## Licença

MIT
