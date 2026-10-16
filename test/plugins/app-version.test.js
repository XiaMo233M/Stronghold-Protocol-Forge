// The ONE judgement that decides whether a plugin is made for this server: its manifest `app` range against
// `PLUGIN_APP_VERSION` — the UPSTREAM game version — never against this fork's release number `APP_VERSION`.
//
// This file is the pin for that rule. Point any of these readers back at `APP_VERSION` (0.19.0, while every plugin template
// and every upstream 0.3.0 manifest declares `>=0.3.0 <0.4.0`) and these tests go red. That is not hypothetical: when the
// 0.3.0 plugin pipeline first landed, `shared/plugins/contentSet.js composeContentSet`'s `usable()` reads
// `manifest.compatible`, so an incompatible plugin was not merely "not loaded" — it was *unknown* (`PLUGIN_UNKNOWN`),
// i.e. `data-demo is not a plugin this set may hold`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_VERSION, PLUGIN_APP_VERSION, UPSTREAM_VERSION } from '../../shared/constants.js';
import { appVersionMatches, readPluginManifest } from '../../shared/plugins/manifest.js';
import { entryStatus } from '../../shared/plugins/catalog.js';
import { appRangeNow } from '../../server/studio/templates/index.js';

/** The `app` range every plugin template in this repo — and every upstream 0.3.0 manifest — declares. */
const GAME_RANGE = '>=0.3.0 <0.4.0';
/** Where this repo's plugin scaffolds live (the studio copies these). */
const TEMPLATES = new URL('../../plugins/_template/', import.meta.url);

/** A content manifest that normalizes without problems (the shape test/plugins/manifest.test.js proves). */
const contentPlugin = (extra = {}) => ({
  manifest: 2, id: 'app-pin', name: 'App pin', version: '1.0.0', app: GAME_RANGE, api: 1,
  class: 'content', scope: ['room'], permissions: ['data.patch', 'data.add'], data: ['data/economy.json'], ...extra,
});

test("the plugin app version is the upstream half — not this fork's release number", () => {
  assert.equal(PLUGIN_APP_VERSION, UPSTREAM_VERSION);
  assert.notEqual(PLUGIN_APP_VERSION, APP_VERSION, 'if these ever coincide this pin must be re-thought, not relaxed');
});

test('appVersionMatches defaults to the upstream half', () => {
  assert.equal(appVersionMatches(GAME_RANGE), true, 'the range every upstream plugin declares must match');
  assert.equal(appVersionMatches(`>=${APP_VERSION}`), false, "a plugin written for this fork's release number is not a game version");
  assert.equal(appVersionMatches('>=0.2.0'), true, "the range this fork's own language packs declare still matches");
});

test('a manifest read with no explicit ctx.app is judged against the upstream half', () => {
  const { manifest, problems } = readPluginManifest(contentPlugin(), { id: 'app-pin' });
  assert.deepEqual(problems, []);
  assert.equal(manifest.compatible, true);
});

test('the catalogue status is judged against the upstream half', () => {
  assert.equal(entryStatus({ id: 'app-pin', version: '1.0.0', app: GAME_RANGE }, undefined).status, 'available');
});

test('the studio scaffolds the app range for the game, not for this fork', () => {
  assert.match(appRangeNow(), /^>=0\.3\.0\b/);
});

test('every plugin template in this repo is compatible through the real manifest reader', () => {
  const ids = fs.readdirSync(TEMPLATES).filter((id) => fs.existsSync(new URL(`${id}/plugin.json`, TEMPLATES)));
  assert.ok(ids.length >= 4, `expected the template plugins, found: ${ids.join(', ') || '(none)'}`);
  for (const id of ids) {
    const raw = JSON.parse(fs.readFileSync(new URL(`${id}/plugin.json`, TEMPLATES), 'utf8'));
    assert.equal(raw.app, GAME_RANGE, `${id} declares the game range`);
    const { manifest } = readPluginManifest(raw, { id });
    assert.ok(manifest, `${id} normalizes to a manifest at all`);
    assert.equal(manifest.compatible, true, `${id} must be compatible against the upstream half`);
  }
});
