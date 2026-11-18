// =============================================================================
// Card registry — dynamic card loading (one JSON file per card)
// =============================================================================
// Cards are read from a list of directories on every use, cached on a fingerprint
// of the files inside them. That means adding, editing or deleting a card file
// takes effect on the next dashboard poll / scraper tick without a restart or a
// UI rebuild.
//
//   CARD_DIRS = config/cards, data/cards     (default; env can override)
//                ^ shipped, git     ^ runtime, gitignored
//
// Later directories win, so a user card can override a shipped card with the
// same id. New cards created through the API are written to the LAST directory.
//
// Failure isolation: one unparseable file becomes an entry in `errors` and keeps
// its previous good version if there was one. It never removes a card from the
// dashboard, and never throws into the scraper loop.
// =============================================================================

// Load .env before reading CARD_DIRS.
import '../env.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardSpecSchema, toFileJson } from './spec.js';
import type { CardSpec } from './spec.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root: <root>/src/cards/registry.ts → <root>. */
export const REPO_ROOT = path.resolve(here, '..', '..');

export type CardSource = 'shipped' | 'user';

/** A card as returned to callers: the spec plus where it came from. */
export interface LoadedCard extends CardSpec {
  source: CardSource;
  source_path: string;
}

export interface CardLoadError {
  file: string;
  message: string;
}

export interface CardRegistry {
  cards: LoadedCard[];
  errors: CardLoadError[];
  dirs: string[];
}

/** Card directories, in precedence order (later wins). */
export function cardDirs(): string[] {
  const raw = process.env.CARD_DIRS?.trim();
  if (raw) {
    return raw
      .split(/[;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => path.resolve(REPO_ROOT, p));
  }
  return [
    path.join(REPO_ROOT, 'config', 'cards'),
    path.join(REPO_ROOT, 'data', 'cards'),
  ];
}

/** Where newly created cards are written. */
export function writableCardDir(): string {
  const dirs = cardDirs();
  return dirs[dirs.length - 1];
}

/** Fingerprint of every card file: dir + name + mtime + size. Content edits do
 *  NOT bump a directory's mtime, so the files themselves must be stamped. */
function fingerprint(dirs: string[]): string {
  return dirs
    .map((dir) => {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
      } catch {
        return `${dir}:missing`;
      }
      const parts = names.map((name) => {
        try {
          const st = fs.statSync(path.join(dir, name));
          return `${name}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${name}:gone`;
        }
      });
      return `${dir}:${parts.join(',')}`;
    })
    .join('|');
}

let cache: { stamp: string; reg: CardRegistry } | null = null;

/**
 * Load every card. Cheap: one readdir + one stat per file, and zero JSON parses
 * when nothing changed.
 */
export function loadRegistry(): CardRegistry {
  const dirs = cardDirs();
  const stamp = fingerprint(dirs);
  if (cache && cache.stamp === stamp) return cache.reg;

  const byId = new Map<string, LoadedCard>();
  const errors: CardLoadError[] = [];
  const previous = cache?.reg;

  dirs.forEach((dir, index) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return; // directory not created yet — not an error
    }

    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        const parsed = CardSpecSchema.parse(raw);
        if (`${parsed.id}.json` !== name) {
          throw new Error(`filename must be "${parsed.id}.json"`);
        }
        byId.set(parsed.id, {
          ...parsed,
          source: index === 0 ? 'shipped' : 'user',
          source_path: file,
        });
      } catch (err) {
        errors.push({
          file,
          message: err instanceof Error ? err.message : String(err),
        });
        // Keep the last good version of this card rather than dropping it.
        const kept = previous?.cards.find((c) => c.source_path === file);
        if (kept) byId.set(kept.id, kept);
      }
    }
  });

  const cards = [...byId.values()].sort(
    (a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );

  const reg: CardRegistry = { cards, errors, dirs };
  cache = { stamp, reg };
  return reg;
}

/** Drop the cache — used after writes so the next read sees them immediately. */
export function invalidateCards(): void {
  cache = null;
}

export function findCard(id: string): LoadedCard | undefined {
  return loadRegistry().cards.find((c) => c.id === id);
}

/** Display label for a provider id, falling back to the raw id. */
export function cardLabel(id: string): string {
  return findCard(id)?.label ?? id;
}

/** Console URL for a provider id, if the card declares one. */
export function cardUrl(id: string): string | undefined {
  return findCard(id)?.url;
}

/** Sort rank for a provider id — unknown ids sort after every known card. */
export function cardRank(id: string): number {
  const cards = loadRegistry().cards;
  const index = cards.findIndex((c) => c.id === id);
  return index === -1 ? cards.length : index;
}

export interface CardSaveResult {
  ok: boolean;
  status: number;
  card?: LoadedCard;
  errors: string[];
}

/**
 * Create or update a card. `id` from the URL wins over the body so a card can
 * never be written to a different file than the one requested.
 *
 * Updates write back to the file the card was loaded from (so editing a shipped
 * card does not silently create a user shadow copy); new cards go to the
 * writable directory. Writes are atomic (tmp + rename).
 */
export function saveCard(id: string, payload: unknown): CardSaveResult {
  const body = typeof payload === 'object' && payload !== null ? payload : {};
  const parsed = CardSpecSchema.safeParse({ ...body, id });

  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }

  const existing = findCard(parsed.data.id);
  const file = existing?.source_path ?? path.join(writableCardDir(), `${parsed.data.id}.json`);
  const payloadJson = `${JSON.stringify(toFileJson(parsed.data), null, 2)}\n`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payloadJson, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      errors: [`cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  invalidateCards();
  const card = findCard(parsed.data.id);
  return card
    ? { ok: true, status: existing ? 200 : 201, card, errors: [] }
    : { ok: false, status: 500, errors: ['card vanished after write'] };
}

export interface CardDeleteResult {
  ok: boolean;
  status: number;
  file?: string;
  errors: string[];
}

/** Delete a card by removing the file it lives in. */
export function deleteCard(id: string): CardDeleteResult {
  const card = findCard(id);
  if (!card) return { ok: false, status: 404, errors: [`no card "${id}"`] };

  try {
    fs.unlinkSync(card.source_path);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      errors: [
        `cannot delete ${card.source_path}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  invalidateCards();
  return { ok: true, status: 200, file: card.source_path, errors: [] };
}
