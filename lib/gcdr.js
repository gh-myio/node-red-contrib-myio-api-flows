'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Bootstrap da CENTRAL_INITIAL_API_KEY junto ao GCDR (RFC-0056).
 *
 * GET {baseUrl}/public/central/initial-key
 *   headers: X-Central-Pre-Key: <CENTRAL_PRE_INITIAL_API_KEY>
 *            uuid: <uuid da central>
 *
 * TOFU: no primeiro contato o GCDR minta uma key única desta central; nas
 * chamadas seguintes devolve a mesma ({ cached: true }) — idempotente.
 * Falhas de auth/uuid retornam 401 genérico (sem oráculo).
 */

/**
 * @param {{baseUrl:string, preKey:string, uuid:string, timeoutMs?:number}} opts
 * @returns {Promise<{apiKey:string, scopes?:string[], customerId?:string, cached?:boolean}>}
 */
function fetchInitialKey(opts) {
  const { baseUrl, preKey, uuid, timeoutMs = 15000 } = opts || {};
  return new Promise((resolve, reject) => {
    if (!baseUrl || !preKey || !uuid) {
      return reject(new Error('gcdr: baseUrl, preKey e uuid são obrigatórios'));
    }
    let u;
    try {
      u = new URL(String(baseUrl).replace(/\/+$/, '') + '/public/central/initial-key');
    } catch (e) {
      return reject(new Error('gcdr: baseUrl inválida: ' + baseUrl));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: { 'X-Central-Pre-Key': preKey, uuid: uuid, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('gcdr: HTTP ' + res.statusCode + ' no bootstrap da initial key'));
        }
        try {
          const json = JSON.parse(data);
          if (!json || typeof json.apiKey !== 'string' || !json.apiKey) {
            return reject(new Error('gcdr: resposta 200 sem apiKey'));
          }
          resolve(json);
        } catch (e) {
          reject(new Error('gcdr: resposta não é JSON válido'));
        }
      });
    });
    req.on('error', (err) => reject(new Error('gcdr: ' + err.message)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('gcdr: timeout após ' + timeoutMs + 'ms')));
  });
}

module.exports = { fetchInitialKey };
