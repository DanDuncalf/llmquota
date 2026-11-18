// =============================================================================
// cards:check — validate the card directory and cross-check state.json
// =============================================================================
// Cards are data, so `tsc` cannot catch a bad one. This is the build-time-ish
// gate: run it before committing a card change.
//
//   npm run cards:check
//
// Exit code 1 when a card fails to load, declares duplicate window ids, or has
// a window id that the scraper can never emit (informational orphans are not
// failures — a JSON-only card is a supported state).
// =============================================================================

import '../env.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../cards/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(here, '../../data/state.json');

let failed = false;
const fail = (message: string): void => {
  failed = true;
  console.error(`  FAIL  ${message}`);
};

const registry = loadRegistry();

console.log(`card dirs: ${registry.dirs.join(', ')}`);
console.log(
  `cards: ${registry.cards.length} (${registry.cards.filter((c) => c.shown).length} shown)`,
);

for (const card of registry.cards) {
  const windows = card.windows.map((w) => w.id);
  const seen = new Set<string>();
  for (const id of windows) {
    if (seen.has(id)) fail(`${card.id}: duplicate window id "${id}"`);
    seen.add(id);
  }
  const unknownDisplay = card.windows.filter(
    (w) => w.tier === 'metered' && w.display === 'percent',
  );
  for (const w of unknownDisplay) {
    console.warn(`  warn  ${card.id}/${w.id}: metered tier but display "percent"`);
  }
  console.log(
    `  ${card.shown ? 'ok  ' : 'tmpl'}  ${card.id.padEnd(14)} ${card.label.padEnd(18)} ` +
      `${String(card.windows.length).padStart(2)}w  ${card.source}`,
  );
}

for (const err of registry.errors) {
  fail(`${err.file}: ${err.message}`);
}

// Cross-check against the last snapshot: which buckets have no card, and which
// cards have no buckets (expected for a card added moments ago).
try {
  const state: unknown = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const buckets = (state as { buckets?: Array<{ provider?: string }> }).buckets ?? [];
  const present = new Set(buckets.map((b) => b.provider ?? ''));
  const cardIds = new Set(registry.cards.map((c) => c.id));
  const orphans = [...present].filter((p) => p && !cardIds.has(p));
  const shownIds = new Set(registry.cards.filter((c) => c.shown).map((c) => c.id));
  const withoutData = [...shownIds].filter((id) => !present.has(id));

  if (orphans.length > 0) {
    console.warn(`  warn  buckets with no card (render generically): ${orphans.join(', ')}`);
  }
  if (withoutData.length > 0) {
    console.log(`  note  cards with no data in the last snapshot: ${withoutData.join(', ')}`);
  }
} catch {
  console.log('  note  no readable data/state.json — skipped the snapshot cross-check');
}

if (failed) {
  console.error('cards:check FAILED');
  process.exit(1);
}
console.log('cards:check OK');
