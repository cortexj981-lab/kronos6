// Create/upgrade the Kronos 6 database and seed config defaults.
import { getDb, ensureDefaults, DB_PATH } from './db.js';
import { k6log } from './log.js';

getDb();
ensureDefaults();
k6log(`[K6 DB] initialized ${DB_PATH} (live trading UNARMED by default)`);
