// READ-ONLY verification: did order 300 actually fill on Kalshi?
// Reads /portfolio/fills and /portfolio/settlements for the market. No writes.
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const keyFile = path.join(import.meta.dirname, '..', 'KalshiAPIKeyFullAccess.txt');
const raw = readFileSync(keyFile, 'utf8');
const keyId = (raw.match(/^[0-9a-f-]{36}$/m) || [])[0];
const pem = (raw.match(/-----BEGIN[\s\S]+?END[^-]*-----/) || [])[0];
async function signedGet(p) {
  const ts = Date.now().toString();
  const msg = ts + 'GET' + '/trade-api/v2' + p.split('?')[0];
  const sig = crypto.sign('sha256', Buffer.from(msg), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  const res = await fetch('https://external-api.kalshi.com/trade-api/v2' + p, {
    headers: { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-SIGNATURE': sig,
               'KALSHI-ACCESS-TIMESTAMP': ts, 'Accept': 'application/json' } });
  return { status: res.status, body: await res.text() };
}
const T = 'KXETH15M-26SEP210445-45';
for (const p of [`/portfolio/fills?ticker=${T}`, `/portfolio/settlements?ticker=${T}`]) {
  const r = await signedGet(p);
  console.log('---', p, '->', r.status);
  console.log(r.body.slice(0, 1200));
}
