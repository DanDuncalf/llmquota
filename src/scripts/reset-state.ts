// =============================================================================
// Reset state — wipe data/state.json and regenerate a fresh random snapshot
// =============================================================================
// Usage:
//   npm run reset-state         # regenerate once and exit
//   npm run reset-state --keep  # regenerate but preserve balances
// =============================================================================

import { resetMockState } from '../scraper/mock-generator.js';

const keep = process.argv.includes('--keep');

if (keep) {
  console.log('[reset-state] --keep flag is a no-op in the current implementation');
}

const state = resetMockState();
console.log(`[reset-state] wrote ${state.buckets.length} buckets to data/state.json`);
for (const b of state.buckets) {
  console.log(
    `  ${b.model_id.padEnd(20)} ${b.waste_risk.padEnd(10)} used=${b.capacity.used_pct.toFixed(1).padStart(5)}% reset=${b.capacity.reset_in_seconds}s`,
  );
}