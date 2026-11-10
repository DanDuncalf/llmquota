// =============================================================================
// Qwen scraper  (Alibaba ModelStudio Token Plan, via the Qwen Code CLI)
// =============================================================================
// The Qwen CLI on this machine is configured against the Alibaba ModelStudio
// Token Plan (see ~/.qwen/settings.json → providerMetadata["token-plan"]), a
// single subscription that fronts models from several vendors (qwen3.x,
// deepseek-v4, kimi-k2.x, glm-5.x, MiniMax-M2.x).
//
// As of writing there is no discoverable public quota endpoint for the token
// plan — the base URL 404s / 503s on every plausible usage path, and the plan's
// allowance is only visible in the Alibaba console. So we emit an `unavailable`
// quota card and let the local-log scanner supply the real per-model token usage
// (which it can, because the Qwen CLI logs usageMetadata per turn).
//
// If a quota endpoint appears later, probe it with BAILIAN_TOKEN_PLAN_API_KEY
// (read from ~/.qwen/settings.json → env) and replace the unavailable bucket.
// =============================================================================

import type { RawBucket } from './base.js';
import { unavailableBucket } from './base.js';

export async function scrapeQwen(): Promise<RawBucket[]> {
  return [
    unavailableBucket({
      model_id: 'qwen-plan',
      provider: 'qwen',
      display_name: 'Qwen · ModelStudio Token Plan',
      window_label: 'token plan',
      tier_type: 'rolling_window',
      reason: 'no public quota endpoint for the ModelStudio Token Plan — token usage shown below',
    }),
  ];
}
