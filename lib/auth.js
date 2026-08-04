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
 * Valida o X-API-Key da request contra a key esperada.
 *
 * OPT-IN: se `expected` for vazio/nulo, a auth está **desligada** (ok:true) —
 * mantém retrocompatibilidade (rotas abertas até configurar a key no node).
 *
 * @returns {{ok:true} | {ok:false, status:number, body:object}}
 */
function checkApiKey(req, expected) {
  if (!expected) return { ok: true }; // sem key configurada → rotas abertas
  const provided = readHeader(req);
  if (!provided) return { ok: false, status: 401, body: { error: 'missing X-API-Key' } };
  if (!safeEqual(provided, expected)) return { ok: false, status: 401, body: { error: 'invalid X-API-Key' } };
  return { ok: true };
}

module.exports = { safeEqual, checkApiKey, readHeader };
