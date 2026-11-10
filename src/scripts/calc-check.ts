// =============================================================================
// Quick spot-check for the calculator — runs the spec decision tree against
// representative inputs and prints PASS/FAIL.
// =============================================================================

import { computeWasteScore, classifyRisk } from '../scraper/calculator.js';

interface Case {
  name: string;
  used: number;
  reset: number;
  tier: 'rolling_window' | 'periodic_fixed' | 'metered';
  want: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'NONE';
}

const cases: Case[] = [
  { name: 'Fresh 5h, 0% used',       used: 0,    reset: 18000,  tier: 'rolling_window', want: 'CRITICAL' },
  { name: 'Half used 5h (HIGH per spec)', used: 50,   reset: 18000,  tier: 'rolling_window', want: 'HIGH' },
  { name: '99% used 5h (exhaust)',   used: 99.5, reset: 18000,  tier: 'rolling_window', want: 'NONE' },
  { name: '20% used 12h reset',      used: 20,   reset: 43200,  tier: 'rolling_window', want: 'CRITICAL' },
  { name: '40% used 36h reset',      used: 40,   reset: 129600, tier: 'rolling_window', want: 'HIGH' },
  { name: 'Metered any state',       used: 50,   reset: 0,      tier: 'metered',        want: 'NONE' },
  { name: '90% used 24h reset LOW',  used: 90,   reset: 86400,  tier: 'rolling_window', want: 'LOW' },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const score = computeWasteScore(c.used, c.reset);
  const r = classifyRisk(c.used, c.reset, c.tier);
  const ok = r.waste_risk === c.want;
  if (ok) pass++;
  else fail++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${c.name.padEnd(30)} score=${score.toFixed(2).padStart(7)} risk=${r.waste_risk.padEnd(9)} pri=${r.routing_priority}`,
  );
}
console.log(`\n  ${pass}/${cases.length} passed`);
process.exit(fail ? 1 : 0);