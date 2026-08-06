'use strict';

const crypto = require('crypto');

/**
 * Autenticação X-API-Key dos endpoints.
 *
 * Comparação time-constant: hasheia os dois lados com SHA-256 (comprimento fixo)
 * e usa crypto.timingSafeEqual — não vaza por tempo nem o valor nem o tamanho da
 * key esperada.
 */

/** Compara duas strings em tempo constante. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Lê o header X-API-Key da request (Express req.get, ou headers cru). */
function readHeader(req) {
  if (!req) return null;
  if (typeof req.get === 'function') return req.get('x-api-key') || null;
  const h = req.headers || {};
  return h['x-api-key'] || h['X-API-Key'] || null;
}

/**
 * Valida o X-API-Key da request contra o conjunto de keys aceitas na rota.
 *
 * `expected` pode ser uma string ou um array de strings — entradas vazias/nulas
 * são ignoradas (key ainda não cadastrada na tabela environment, por exemplo).
 *
 * OPT-IN: conjunto vazio → auth **desligada** (ok:true, matched:null) —
 * mantém retrocompatibilidade (rotas abertas até existir key cadastrada).
 *
 * `matched` devolve QUAL key bateu, para o caller distinguir o papel
 * (CENTRAL_API_KEY completa vs CENTRAL_INITIAL_API_KEY restrita).
 *
 * @returns {{ok:true, matched:string|null} | {ok:false, status:number, body:object}}
 */
function checkApiKey(req, expected) {
  const keys = (Array.isArray(expected) ? expected : [expected])
    .filter((k) => typeof k === 'string' && k.length > 0);
  if (!keys.length) return { ok: true, matched: null }; // sem key configurada → rotas abertas
  const provided = readHeader(req);
  if (!provided) return { ok: false, status: 401, body: { error: 'missing X-API-Key' } };
  let matched = null;
  for (const k of keys) if (safeEqual(provided, k)) matched = k; // percorre todas (sem short-circuit)
  if (matched === null) return { ok: false, status: 401, body: { error: 'invalid X-API-Key' } };
  return { ok: true, matched };
}

module.exports = { safeEqual, checkApiKey, readHeader };
