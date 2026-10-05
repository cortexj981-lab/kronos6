// READ-ONLY probe: does GET /portfolio/balance report a per-exchange-shard figure?
//
// Kalshi splits collateral per exchange shard (Exchange 0 Default, 1 Combos,
// 2 Crypto, 3 Tennis & Baseball). The ETH 15m markets Kronos 6 trades live on
// shard 2. getBalance() currently reads the ACCOUNT-WIDE total, which overstates
// usable ETH collateral by whatever is stranded in the other shards.
//
// This script only issues GETs on the already-allowlisted balance path.
// It writes nothing and places no orders.

import { getBalance } from '../scanner/kalshi-client.ts';

const raw = await getBalance();
console.log('getBalance() (account-wide):', JSON.stringify(raw));

// Probe the same allowlisted path with a shard hint, to see whether the API
// narrows the response. If it ignores the parameter the numbers will be identical.
const { KALSHI_REST_URL } = await import('../scanner/config.ts');

// Reuse the signed client by calling the exported helpers only; for the raw probe
// we re-sign here using the same key material the client loads.
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const keyFile = path.join(import.meta.dirname, '..', 'KalshiAPIKeyFullAccess.txt');
const text = readFileSync(keyFile, 'utf8');
const keyId = (text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
const pem = (text.match(/-----BEGIN[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/) || [])[0];
if (!keyId || !pem) { console.log('could not parse credentials; skipping raw probe'); process.exit(0); }

async function signedGet(pathAndQuery) {
  const ts = Date.now().toString();
  const apiPath = '/trade-api/v2' + pathAndQuery.split('?')[0];
  const msg = ts + 'GET' + apiPath;
  const sig = crypto.sign('sha256', Buffer.from(msg), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString('base64');
  const res = await fetch('https://external-api.kalshi.com/trade-api/v2' + pathAndQuery, {
    headers: {
      'KALSHI-ACCESS-KEY': keyId,
      'KALSHI-ACCESS-SIGNATURE': sig,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      Accept: 'application/json',
    },
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

for (const q of ['/portfolio/balance',
                 '/portfolio/balance?exchange_index=2',
                 '/portfolio/balance?exchange_index=0']) {
  const r = await signedGet(q);
  console.log(q, '->', r.status, r.body);
}
