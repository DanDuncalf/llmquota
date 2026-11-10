// =============================================================================
// Minimal .env loader (no dependency)
// =============================================================================
// Reads KEY=value lines from ./.env (relative to the project root) and copies
// them into process.env WITHOUT overriding variables that are already set.
// That way real OS/user environment variables always win, and .env is just a
// convenient place to keep the handful of secrets the scraper needs.
//
// Import this FIRST — before anything that reads process.env at import time.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.QUOTA_ENV_FILE ?? path.resolve(here, '../.env');

function parse(content: string): void {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Never clobber real environment variables.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

try {
  if (fs.existsSync(ENV_PATH)) parse(fs.readFileSync(ENV_PATH, 'utf8'));
} catch (err) {
  console.warn('[env] failed to load .env:', err);
}
