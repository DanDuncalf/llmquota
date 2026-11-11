// =============================================================================
// Assemble per-provider model catalogs + usage rollups for the state file
// =============================================================================
// Combines three inputs:
//   * catalogs  — model lists from provider APIs (where available)
//   * rollups   — per-model token usage from local CLI logs
//   * monthly   — DeepInfra's month-granularity billing tokens
// =============================================================================

import { PROVIDER_ORDER, modelKey } from '../../types/quota.js';
import type { Provider, ProviderModels } from '../../types/quota.js';
import type { ModelRollup, LocalUsageResult } from './local-usage.js';
import { emptyTally } from './local-usage.js';
import type { CatalogResult, MonthlyUsage } from './catalogs.js';
import type { DeepSeekPlatformUsage } from './deepseek-platform.js';

interface BuildInput {
  catalogs: Record<Provider, CatalogResult>;
  rollups: ModelRollup[];
  monthly: MonthlyUsage | null;
  local: LocalUsageResult;
  deepseekPlatform?: DeepSeekPlatformUsage | null;
}

function usageSourceFor(provider: Provider, hasLocal: boolean): string {
  const localLabel = 'local CLI logs (Claude Code, Codex, Kimi Code, Qwen)';
  if (provider === 'deepinfra') return 'DeepInfra billing API (monthly)';
  if (hasLocal) return localLabel;
  return 'none';
}

/** Which local CLI log source feeds which provider. */
const SOURCE_PROVIDER: Record<string, Provider> = {
  claude: 'anthropic',
  codex: 'openai',
  kimi: 'moonshot',
  qwen: 'qwen',
};

function lastActivityFor(provider: Provider, local: LocalUsageResult): string | undefined {
  let best = 0;
  for (const [source, p] of Object.entries(SOURCE_PROVIDER)) {
    if (p !== provider) continue;
    const t = local.sourceLatest[source];
    if (t && t > best) best = t;
  }
  return best > 0 ? new Date(best).toISOString() : undefined;
}

export function buildProviderModels(input: BuildInput): ProviderModels[] {
  const { catalogs, rollups, monthly, local, deepseekPlatform } = input;

  // Gemini quota cards are account-scoped; their model list is already the
  // quota row list, so a second per-provider usage table would be misleading.
  const providers = PROVIDER_ORDER.filter((p) => p !== 'gemini');

  return providers.map((provider) => {
    const cat = catalogs[provider];
    const localRolls = rollups.filter((r) => r.provider === provider);
    const platformDeepSeek =
      provider === 'deepseek' ? deepseekPlatform?.rollups ?? [] : [];
    const platformUsed = platformDeepSeek.length > 0;
    const observedRolls = platformUsed ? platformDeepSeek : localRolls;

    // Union the advertised catalog with anything we've actually observed, so a
    // model you use but that isn't in the catalog still shows up. Compare on
    // modelKey() because log ids are often prefixed (e.g. "kimi-code/k3") —
    // without this, the prefixed log id would appear as a second catalog entry.
    const catalogKeys = new Set(cat.models.map(modelKey));
    const observedOnly = observedRolls
      .map((r) => r.model)
      .filter((m) => !catalogKeys.has(modelKey(m)));
    const catalog = [...new Set([...cat.models, ...observedOnly])].sort();

    let catalog_source: ProviderModels['catalog_source'] = cat.source;
    if ((cat.source === 'provider_api' || cat.source === 'local_config') && observedOnly.length > 0) {
      catalog_source = 'mixed';
    }

    const usage = observedRolls.map((r) => ({
      model: r.model,
      windows: { h1: r.h1, h5: r.h5, h24: r.h24 },
      last_seen: r.lastSeen ? new Date(r.lastSeen).toISOString() : undefined,
      in_catalog: catalogKeys.has(modelKey(r.model)),
    }));

    const notes: string[] = [];
    if (cat.source === 'unavailable' && cat.error) {
      notes.push(`catalog unavailable (${cat.error})`);
    }
    if (cat.source === 'observed') {
      notes.push('catalog inferred from local usage (no public model list for this provider)');
    }
    if (provider === 'deepinfra' && !monthly) {
      notes.push('no token data returned by billing API');
    }
    if (platformUsed) {
      notes.push('platform usage is a calendar-day bucket (today), not a rolling 24h; 1h/5h unavailable');
    }
    if (provider === 'deepseek' && deepseekPlatform?.error) {
      notes.push(deepseekPlatform.error);
    }

    return {
      provider,
      catalog,
      catalog_labels: cat.labels,
      catalog_source,
      usage,
      usage_source: platformUsed
        ? 'DeepSeek platform API (today)'
        : usageSourceFor(provider, localRolls.length > 0),
      last_activity: platformUsed
        ? new Date().toISOString()
        : lastActivityFor(provider, local),
      monthly: provider === 'deepinfra' && monthly ? monthly : undefined,
      note: notes.length > 0 ? notes.join(' · ') : undefined,
    } satisfies ProviderModels;
  }).map((pm) => {
    // Providers with no catalog and no usage at all get an explicit note.
    if (pm.catalog.length === 0 && pm.usage.length === 0 && !pm.note && !pm.monthly) {
      return {
        ...pm,
        note:
          local.sourcesMissing.length > 0
            ? `no catalog and no local usage logs (missing: ${local.sourcesMissing.join(', ')})`
            : 'no catalog and no local usage in the last 24h',
      };
    }
    return pm;
  });
}

/** Empty rollup helper re-exported for callers that need a zero tally. */
export { emptyTally };
