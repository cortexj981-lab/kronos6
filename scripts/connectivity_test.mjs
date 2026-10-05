// Kronos 6 connectivity & verification test — READ-ONLY against the live
// account. Verifies credentials, request-gate behavior, account access,
// KXETH15M discovery, live quote, candle alignment, fee metadata, and clock
// sync. PLACES NO ORDERS and changes nothing on the account.
//   cd C:\Claude\Kronos6\scanner
//   node --experimental-sqlite --import tsx/esm ..\scripts\connectivity_test.mjs
import { assertAllowedRequest, KALSHI_REST_URL, SERIES_TICKER, CANDLE_MS, MAX_CLOCK_SKEW_MS } from '../scanner/config.js';
import { credentialSummary } from '../scanner/kalshi-auth.js';
import { getMarkets, getOrderbook, getExchangeStatus, getSeries, getBalance, getOrders, getLastClockSkewMs } from '../scanner/kalshi-client.js';
import { discoverTargetMarket, readLiveNoQuote, describeMarket } from '../scanner/kalshi-markets.js';
import { fetchCandles } from '../scanner/candles.js';

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.error(`  FAIL  ${m}`); failures++; };

console.log('=== Kronos 6 connectivity test (LIVE account — read-only checks, no orders) ===\n');

// ---- V1: credential file ----------------------------------------------------
console.log('V1 — full-access credential file');
try {
  const c = credentialSummary();
  ok(`credential file found (${c.file})`);
  ok(`API Key ID loaded (${c.apiKeyIdPrefix})`);
  ok(`private key parsed: ${c.keyParsed}`);
} catch (e) { bad(`credential load: ${e.message}`); }

// ---- V2: request-gate behavior (must all be REJECTED) -------------------------
console.log('\nV2 — fail-closed request gate');
const mustThrow = (label, fn) => {
  try { fn(); bad(`${label} was NOT rejected`); }
  catch { ok(`${label} rejected`); }
};
mustThrow('POST to a non-order path', () => assertAllowedRequest('POST', `${KALSHI_REST_URL}/markets`));
mustThrow('DELETE of a non-order path', () => assertAllowedRequest('DELETE', `${KALSHI_REST_URL}/portfolio/balance`));
mustThrow('PUT (never used)', () => assertAllowedRequest('PUT', `${KALSHI_REST_URL}/portfolio/events/orders`));
mustThrow('non-approved host', () => assertAllowedRequest('GET', 'https://external-api.demo.kalshi.co/trade-api/v2/markets'));
mustThrow('api_keys path', () => assertAllowedRequest('GET', `${KALSHI_REST_URL}/api_keys`));
mustThrow('GET of unlisted path', () => assertAllowedRequest('GET', `${KALSHI_REST_URL}/events`));
try { assertAllowedRequest('POST', `${KALSHI_REST_URL}/portfolio/events/orders`); ok('POST order-create endpoint allowed'); } catch (e) { bad(`order-create POST rejected: ${e.message}`); }
try { assertAllowedRequest('GET', `${KALSHI_REST_URL}/portfolio/balance`); ok('GET balance allowed'); } catch (e) { bad(`balance GET rejected: ${e.message}`); }

// ---- V3: live account access ---------------------------------------------------
console.log('\nV3 — live Kalshi account access');
try {
  const ex = await getExchangeStatus();
  ok(`exchange status (public): trading_active=${ex.trading_active}`);
} catch (e) { bad(`exchange status: ${e.message}`); }
try {
  const b = await getBalance();
  ok(`authenticated balance read: $${b.balanceDollars.toFixed(2)}`);
} catch (e) { bad(`balance: ${e.message}`); }
try {
  await getOrders({ limit: 1 });
  ok('portfolio orders read (order permissions confirmed)');
} catch (e) { bad(`orders read: ${e.message}`); }
try {
  const s = await getSeries(SERIES_TICKER);
  if (s.series.fee_type === 'quadratic' && Number(s.series.fee_multiplier ?? 1) === 1) ok(`series fee model unchanged: quadratic x1`);
  else bad(`series fee model CHANGED: ${s.series.fee_type} x${s.series.fee_multiplier}`);
} catch (e) { bad(`series fee info: ${e.message}`); }
const skew = getLastClockSkewMs();
if (skew != null && Math.abs(skew) <= MAX_CLOCK_SKEW_MS) ok(`clock skew ${Math.round(skew)}ms (limit ${MAX_CLOCK_SKEW_MS}ms)`);
else bad(`clock skew ${skew == null ? 'unknown' : Math.round(skew) + 'ms'}`);

// ---- V4: KXETH15M on the live exchange ----------------------------------------
console.log(`\nV4 — live ${SERIES_TICKER} markets`);
let anyMarket = null;
try {
  const res = await getMarkets({ series_ticker: SERIES_TICKER, limit: 10 });
  console.log(`  ${SERIES_TICKER} markets listed: ${res.markets.length}`);
  if (res.markets.length === 0) bad('no KXETH15M markets listed');
  else { ok('live exchange lists KXETH15M markets'); anyMarket = res.markets[0]; }
} catch (e) { bad(`market list: ${e.message}`); }

// ---- V5: current-window market + live quote ------------------------------------
console.log('\nV5 — current 15m window market + live quote');
const windowStart = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
try {
  const d = await discoverTargetMarket(windowStart);
  const target = d.market ?? anyMarket;
  if (d.market) ok(`current-window market: ${describeMarket(d.market)}`);
  else console.log(`  note: no active current-window market right now (${d.rejected[0] ?? ''})`);
  if (target) {
    const ob = await getOrderbook(target.ticker, 4);
    ok(`authenticated orderbook read: ${ob.orderbook_fp.yes_dollars.length} YES levels, ${ob.orderbook_fp.no_dollars.length} NO levels`);
    const q = await readLiveNoQuote(target);
    if (q) ok(`live NO quote: exec=${q.execPrice} src=${q.priceSource} bookSize=${q.size ?? 'n/a'}${q.warning ? ` (warning: ${q.warning})` : ''}`);
    else console.log('  note: no usable price data on this market right now');
  }
} catch (e) { bad(`discovery/quote: ${e.message}`); }

// ---- V6: candle alignment --------------------------------------------------------
console.log('\nV6 — 15m candle alignment (Coinbase)');
try {
  const candles = await fetchCandles('ETHUSD', 240);
  const last = candles[candles.length - 1];
  const misaligned = candles.filter((c) => c.ts % CANDLE_MS !== 0);
  if (misaligned.length === 0) ok(`all ${candles.length} candles UTC quarter-hour aligned`);
  else bad(`${misaligned.length} misaligned candles`);
  if (last.ts <= Date.now() - CANDLE_MS) ok('in-progress candle excluded');
  else bad('last candle is not closed!');
} catch (e) { bad(`candles: ${e.message}`); }

console.log(failures === 0 ? '\nAll connectivity checks PASSED. (No orders were placed.)' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
