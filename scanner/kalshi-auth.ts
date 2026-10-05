// Kalshi API request signing — identical scheme to Kronos 5:
//   message = `${timestampMs}${METHOD}${path}`   (path includes /trade-api/v2,
//   excludes query string), signed RSA-PSS/SHA-256 with salt length = digest
//   length, base64-encoded.
// SECURITY: this module never logs or exports key material. Only the key ID
// prefix (non-secret) is exposed for logging. The credential file is the
// FULL-ACCESS live key — it must never be copied, logged, or stored in SQLite.
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign, constants, type KeyObject } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIAL_FILE = path.join(__dirname, '..', 'KalshiAPIKeyFullAccess.txt');

export interface KalshiCredentials {
  apiKeyId: string;
  /** Parsed private key object. Never serialize, never log. */
  privateKey: KeyObject;
}

let cached: KalshiCredentials | null = null;

/**
 * Credential file format (same as Kronos 5): first non-empty line is the
 * API Key ID (UUID), followed by a PEM RSA private key block.
 */
export function loadCredentials(): KalshiCredentials {
  if (cached) return cached;
  const raw = readFileSync(CREDENTIAL_FILE, 'utf8');
  const pemStart = raw.indexOf('-----BEGIN');
  if (pemStart < 0) throw new Error('[K6 AUTH] credential file: no PEM private key block found');
  const head = raw.slice(0, pemStart);
  const apiKeyId = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  if (!apiKeyId || !/^[0-9a-f-]{20,}$/i.test(apiKeyId)) {
    throw new Error('[K6 AUTH] credential file: could not parse API Key ID from header lines');
  }
  const pem = raw.slice(pemStart);
  const privateKey = createPrivateKey(pem); // throws if unparseable
  cached = { apiKeyId, privateKey };
  return cached;
}

/** Sign one request. Returns the three Kalshi auth headers. */
export function signRequest(method: string, pathWithPrefix: string, timestampMs?: number): Record<string, string> {
  const { apiKeyId, privateKey } = loadCredentials();
  const ts = String(timestampMs ?? Date.now());
  const pathOnly = pathWithPrefix.split('?')[0];
  const message = Buffer.from(`${ts}${method.toUpperCase()}${pathOnly}`, 'utf8');
  const signature = cryptoSign('sha256', message, {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}

/** Non-secret validation info for logs. */
export function credentialSummary(): { file: string; apiKeyIdPrefix: string; keyParsed: boolean } {
  const c = loadCredentials();
  return {
    file: path.basename(CREDENTIAL_FILE),
    apiKeyIdPrefix: c.apiKeyId.slice(0, 8) + '…',
    keyParsed: c.privateKey.type === 'private',
  };
}
