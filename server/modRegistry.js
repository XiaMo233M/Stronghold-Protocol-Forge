// server/modRegistry.js — the mod manager's **registry** (docs/WORKSHOP.md): one state file that records what the
// manager installed and which packs the operator enabled or disabled, plus the pure half that applies it to a loaded
// set. The plan's rule this exists for: **a pack the operator disabled must be exactly as absent as one that failed to
// load** — no hooks, no panels, no media, no data overlay — while the file stays on disk for a one-line re-enable.
//
// Layout of `mod-registry.json` (in the state root, `server/modModules.js stateRootFor` — the same tree the server
// modules write to, never inside the workshop/ pack root the loader scans):
//
//   { "version": 1,
//     "packs": { "<pack id>": { "state": "enabled" | "disabled",
//                               "installedAt": "<ISO date>",      // what the manager recorded at import
//                               "source": "<file name|dir>",      // where the bytes came from
//                               "digest": "<sha256>",             // the pack.json digest the receipt names
//                               "previous": { "digest": "<sha256>", "backup": "<relative backup dir>" } } } }
//
// A pack that is not in the registry at all is **enabled**: installing a pack makes it work immediately (the
// behaviour every existing install relies on); disabling is the operator's explicit act. The state file is the one
// truth — the CLI, the editor and the server read it, none of them keeps a second copy.

import fs from 'node:fs';
import path from 'node:path';
import { PACK_ID_RE } from '../shared/workshop.js';
import { stateRootFor } from './modModules.js';

/** The registry file's name inside the state root. */
export const MOD_REGISTRY_FILE = 'mod-registry.json';
const STATES = Object.freeze(['enabled', 'disabled']);
const REGISTRY_VERSION = 1;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Validate one registry entry: everything unknown or malformed is dropped **by name** (the caller reports it), so a
 * hand-edited or older state file can never half-apply.
 * @returns {{ entry: { state: 'enabled'|'disabled', installedAt?: string, source?: string, digest?: string,
 *                      previous?: { digest: string, backup: string } } | null, issues: string[] }}
 */
export function normalizePackEntry(raw) {
  const issues = [];
  if (!isObj(raw)) return { entry: null, issues: ['the entry is not a JSON object'] };
  const state = raw.state === undefined ? 'enabled' : raw.state;
  if (!STATES.includes(state)) { issues.push(`"state": ${JSON.stringify(raw.state)} is not one of ${STATES.join(' / ')}`); return { entry: null, issues }; }
  const entry = { state };
  if (raw.installedAt !== undefined) {
    if (!isIsoDate(raw.installedAt)) issues.push(`"installedAt": ${JSON.stringify(raw.installedAt)} is not a date (dropped)`);
    else entry.installedAt = raw.installedAt;
  }
  for (const key of ['source', 'digest']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || !raw[key].trim()) issues.push(`"${key}": not a non-empty string (dropped)`);
      else entry[key] = raw[key].trim();
    }
  }
  if (raw.previous !== undefined) {
    const p = raw.previous;
    if (!isObj(p) || typeof p.digest !== 'string' || !p.digest.trim() || typeof p.backup !== 'string' || !p.backup.trim()
      || p.backup.includes('..') || path.isAbsolute(p.backup)) {
      issues.push('"previous": must be { digest, backup } with a pack-relative backup directory (dropped)');
    } else entry.previous = { digest: p.digest.trim(), backup: p.backup.trim() };
  }
  return { entry, issues };
}

/**
 * Validate a whole registry file body. Unknown pack ids (not a pack id / not an object) are dropped by name.
 * @returns {{ registry: { version: number, packs: Record<string, object> }, issues: string[] }}
 */
export function normalizeRegistry(raw) {
  const issues = [];
  const packs = {};
  if (raw === undefined || raw === null) return { registry: { version: REGISTRY_VERSION, packs }, issues };
  if (!isObj(raw)) { issues.push('the registry file is not a JSON object'); return { registry: { version: REGISTRY_VERSION, packs }, issues }; }
  if (raw.version !== undefined && raw.version !== REGISTRY_VERSION) issues.push(`"version": ${JSON.stringify(raw.version)} is not ${REGISTRY_VERSION} (read anyway)`);
  const rawPacks = isObj(raw.packs) ? raw.packs : {};
  if (!isObj(raw.packs) && raw.packs !== undefined) issues.push('"packs" is not a JSON object (read as empty)');
  for (const [id, entry] of Object.entries(rawPacks)) {
    if (!PACK_ID_RE.test(id)) { issues.push(`"${id}" is not a pack id (dropped)`); continue; }
    const n = normalizePackEntry(entry);
    issues.push(...n.issues.map((i) => `${id}: ${i}`));
    if (n.entry) packs[id] = n.entry;
  }
  return { registry: { version: REGISTRY_VERSION, packs }, issues };
}

/** The registry file's absolute path for a state root. */
export function registryPath(stateRoot) { return path.join(stateRoot, MOD_REGISTRY_FILE); }

/** Read the registry (a missing file is an empty one); malformed lines are dropped and returned. */
export function readModRegistry(stateRoot, { log = null } = {}) {
  const file = registryPath(stateRoot);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') log?.warn?.(`[mod-registry] ${MOD_REGISTRY_FILE} unreadable (${e.message}) — starting from an empty registry`);
    return { version: REGISTRY_VERSION, packs: {} };
  }
  const { registry, issues } = normalizeRegistry(raw);
  for (const i of issues) log?.warn?.(`[mod-registry] ${i}`);
  return registry;
}

/** Write the registry atomically (temp file + rename in the same directory). */
export function writeModRegistry(stateRoot, registry) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const file = registryPath(stateRoot);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return registry;
}

/** One mutation: read → change → write. Returns the new registry. */
function mutate(stateRoot, id, fn) {
  const registry = readModRegistry(stateRoot);
  const entry = registry.packs[id] || { state: 'enabled' };
  const next = fn(entry);
  if (next) registry.packs[id] = next; else delete registry.packs[id];
  writeModRegistry(stateRoot, registry);
  return registry;
}

/** Enable a pack (the operator's re-enable; records stay). */
export function enablePack(stateRoot, id) { return mutate(stateRoot, id, (e) => ({ ...e, state: 'enabled' })); }
/** Disable a pack: the file stays on disk, the server stops loading it. */
export function disablePack(stateRoot, id) { return mutate(stateRoot, id, (e) => ({ ...e, state: 'disabled' })); }
/** Record what the manager installed (called by the import path). */
export function recordInstall(stateRoot, id, { source, digest, installedAt = new Date().toISOString() } = {}) {
  return mutate(stateRoot, id, (e) => ({ ...e, state: e.state || 'enabled', installedAt, ...(source ? { source } : {}), ...(digest ? { digest } : {}) }));
}
/** Record the displaced previous version of an upgrade (the rollback target). */
export function recordBackup(stateRoot, id, { digest, backup }) {
  return mutate(stateRoot, id, (e) => ({ ...e, previous: { digest, backup } }));
}
/** Drop a pack's record (the uninstall path; the caller removes the files). */
export function forgetPack(stateRoot, id) { return mutate(stateRoot, id, () => null); }

/**
 * The pure half: apply the registry to a loaded pack set. Disabled packs leave the set **before** any payload
 * (server modules, kits, panels, media, data overlay) is computed, so a disabled pack has no hooks, no subscriptions
 * and no bytes anywhere — exactly like a pack that failed to load, except the file stays on disk.
 * @param {{ id: string, where?: string }[]} packs the loaded packs (loadWorkshop's `packs`)
 * @param {{ version: number, packs: Record<string, object> }} registry
 * @returns {{ packs: unknown[], disabled: { id: string, where: string, reason: string }[] }}
 */
export function applyModRegistry(packs, registry) {
  const list = Array.isArray(packs) ? packs : [];
  const out = [];
  const disabled = [];
  for (const p of list) {
    const entry = registry?.packs?.[p.id];
    if (entry?.state === 'disabled') {
      disabled.push({ id: p.id, where: p.where || p.dir || `workshop/${p.id}/`, reason: 'disabled by the operator (mod-registry)' });
      continue;
    }
    out.push(p);
  }
  return { packs: out, disabled };
}
