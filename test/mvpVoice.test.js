// The settlement's voice line (owner's rule 2026-10-06): 「结算页用 MVP 干员语音说一句，每个玩家不一样（各自队伍里的 MVP）」.
//
// The server picks each player's MVP from the per-unit numbers of the VERIFIED battle report (Match.js accumulates them
// into ps.stats.unitStats, results.js mvpOf reads them), puts it in the player's result entry as `mvp`, and each client
// asks `audio.voice(<its own MVP>, 'win' | 'lose')`. A client cannot name its own MVP.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mvpOf } from '../server/match/results.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const ps = (pairs) => ({ stats: { unitStats: new Map(pairs) } });
const lineup = (...ids) => ids.map((id) => ({ id }));

describe('settlement MVP (mvpOf): the unit the result screen speaks with', () => {
  test('the most damage wins, kills break a tie', () => {
    assert.equal(mvpOf(ps([['char_a', { dmg: 100, kills: 1 }], ['char_b', { dmg: 500, kills: 0 }]]), lineup('char_a', 'char_b')), 'char_b');
    assert.equal(mvpOf(ps([['char_a', { dmg: 500, kills: 1 }], ['char_b', { dmg: 500, kills: 3 }]]), lineup('char_a', 'char_b')), 'char_b');
    // a full tie keeps the lineup's own order (the earlier-placed unit wins)
    assert.equal(mvpOf(ps([['char_a', { dmg: 500, kills: 2 }], ['char_b', { dmg: 500, kills: 2 }]]), lineup('char_a', 'char_b')), 'char_a');
  });

  test('only units still in the lineup qualify — a sold operator is not the team’s MVP', () => {
    assert.equal(mvpOf(ps([['char_a', { dmg: 9999, kills: 9 }], ['char_b', { dmg: 10, kills: 0 }]]), lineup('char_b')), 'char_b');
    assert.equal(mvpOf(ps([['char_a', { dmg: 9999, kills: 9 }]]), lineup('char_b')), null, 'nobody in the lineup has a number');
  });

  test('a unit that did nothing is never the MVP; an empty lineup or no stats at all → null', () => {
    assert.equal(mvpOf(ps([['char_a', { dmg: 0, kills: 0 }]]), lineup('char_a')), null, 'a summon that only stood there');
    assert.equal(mvpOf(ps([]), lineup('char_a')), null);
    assert.equal(mvpOf(ps([['char_a', { dmg: 50, kills: 0 }]]), lineup()), null);
    assert.equal(mvpOf({ stats: {} }, lineup('char_a')), null, 'no accumulation yet (a match that never fought)');
    assert.equal(mvpOf(null, lineup('char_a')), null);
    assert.equal(mvpOf(ps([['char_a', { dmg: 50, kills: 0 }]]), null), null);
  });

  test('healing alone does not make an MVP (a pure healer still needs a kill or damage to speak)', () => {
    assert.equal(mvpOf(ps([['char_a', { dmg: 0, kills: 0, heal: 9000 }]]), lineup('char_a')), null);
    assert.equal(mvpOf(ps([['char_a', { dmg: 0, kills: 2, heal: 9000 }]]), lineup('char_a')), 'char_a', 'kills are enough');
  });

  test('nonsense numbers never win or throw', () => {
    assert.equal(mvpOf(ps([['char_a', { dmg: 'x', kills: undefined }], ['char_b', { dmg: 1, kills: 0 }]]), lineup('char_a', 'char_b')), 'char_b');
    assert.equal(mvpOf(ps([['char_a', { dmg: -5, kills: -2 }]]), lineup('char_a')), null, 'negative sums are treated as nothing');
  });

  test('the wiring is pinned: the server puts `mvp` in the player entry, the client speaks it', () => {
    const server = read('server/match/results.js');
    assert.match(server, /export function mvpOf\(/, 'results.js exports the picker');
    assert.match(server, /mvp: mvpOf\(ps, lineup\)/, 'every player entry carries its own MVP');
    // upstream 0.2.0 split Match.js: the per-battle accumulator now lives in match/settle.js
    const settle = read('server/match/match/settle.js');
    assert.match(settle, /ps\.stats\.unitStats\.set\(/, 'settle.js accumulates the per-unit numbers');
    assert.match(settle, /mergeUnits\(r\.unitStats\)/, 'from the verified battle report');
    assert.match(settle, /mergeUnits\(up\.unitStats\)/, 'and from the 联防 half too');
    const screen = read('public/js/screens/result.js');
    assert.match(screen, /mine\.mvp/, 'the result screen reads the local player\'s MVP');
    // the slot vocabulary is the upstream client's (shared/constants.js VOICE_SLOTS): 高难 / 3 星 / 失败
    assert.match(screen, /audio\.voice\(mine\.mvp, r\.victory \? \(hard \? 'resultFour' : 'resultThree'\) : 'resultLose'\)/, 'and says the result line with it');
    const state = read('server/match/PlayerState.js');
    assert.match(state, /unitStats: new Map\(\)/, 'PlayerState starts the accumulator');
  });
});
