// =============================================================================
// Smoke test — real MCP handshake against the local llmquota MCP server
// =============================================================================
//   npm run test:agent
//
// Exercises: tools/list, tools/call for a company, a model, a prepaid balance,
// an Agy account, and the list tool. Reads the live dashboard snapshot
// (state.json or the API on 127.0.0.1:8787).
// =============================================================================

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverPath = path.join(root, 'src', 'agent', 'mcp-server.ts');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [tsxCli, serverPath],
  stderr: 'pipe',
});

const client = new Client({ name: 'llmquota-smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ['get_quota', 'list_quota']);
console.log('tools/list ok:', names.join(', '));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(res.content?.[0]?.text, `${name} returned no text`);
  const json = JSON.parse(res.content[0].text);
  assert.equal(json.ok, true, `${name} failed: ${res.content[0].text}`);
  return json;
}

// 1. company query — Kimi plan windows
const kimi = await call('get_quota', { query: 'kimi' });
const kimiProvider = kimi.providers[0];
assert.equal(kimi.matched_by, 'provider');
assert.equal(kimiProvider.provider, 'moonshot');
assert.ok(kimiProvider.five_hour, 'Kimi should have a 5h window');
assert.ok(kimiProvider.weekly, 'Kimi should have a weekly window');
assert.ok(Number.isFinite(kimiProvider.five_hour.remaining_pct));
console.log(
  'get(kimi) ok: 5h left',
  kimiProvider.five_hour.remaining_pct + '%',
  '| weekly left',
  kimiProvider.weekly.remaining_pct + '%',
);

// 2. model query — resolves to the provider serving it
const model = await call('get_quota', { query: 'gpt-6.1-sol' });
assert.equal(model.matched_by, 'model');
assert.equal(model.providers[0].provider, 'openai');
console.log('get(model) ok: gpt-6.1-sol ->', model.providers[0].provider);

// 3. metered balance — dollars left
const deepseek = await call('get_quota', { query: 'deepseek' });
const ds = deepseek.providers[0];
assert.equal(typeof ds.dollars_left, 'number');
console.log('get(deepseek) ok: dollars_left =', ds.dollars_left);

// 4. Agy harness — one entry per linked Google account
const agy = await call('get_quota', { query: 'agy' });
assert.equal(agy.matched_by, 'provider');
assert.ok(agy.providers.length >= 1, 'expected at least one Gemini/Agy account');
assert.ok(agy.providers.every((p) => p.provider === 'gemini'));
assert.ok(agy.providers.every((p) => p.account));
assert.ok(agy.providers.every((p) => p.harness === 'agy'));
assert.ok(agy.providers.every((p) => p.weekly), 'each Agy account should expose a weekly window');
assert.ok(agy.providers.every((p) => Array.isArray(p.catalog) && p.catalog.length >= 1));
console.log(
  'get(agy) ok:',
  agy.providers.map((p) => `${p.account} (${p.weekly.remaining_pct}% weekly left)`).join(' | '),
);

// 5. account query — target one Agy account, using the local-part of the
// first account from step 4 so no private email is hardcoded here.
const targetAccount = agy.providers[0].account;
const localPart = targetAccount.split('@')[0];
const byAccount = await call('get_quota', { query: localPart });
assert.equal(byAccount.matched_by, 'account');
assert.ok(byAccount.providers.some((p) => p.account === targetAccount));
console.log('get(account) ok:', byAccount.providers.length, 'account(s) matched local-part');

// 6. Agy model query — static catalog resolves to the Gemini entries
const agyModel = await call('get_quota', { query: 'gemini-3.8-flash-high' });
assert.equal(agyModel.matched_by, 'model');
assert.ok(agyModel.providers.some((p) => p.provider === 'gemini'));
console.log('get(agy model) ok: gemini-3.8-flash-high');

// 7. list everything
const list = await call('list_quota', {});
assert.ok(list.providers.length >= 5, 'expected at least 5 providers');
console.log('list ok:', list.providers.length, 'providers');

// 8. unknown query — clean, non-throwing miss with suggestions
const miss = await call('get_quota', { query: 'not-a-real-provider' });
assert.equal(miss.providers.length, 0);
assert.ok(miss.warnings.some((w) => w.includes('no provider or model matched')));
console.log('miss ok: suggestions present');

await client.close();
console.log('\nall smoke tests passed');
