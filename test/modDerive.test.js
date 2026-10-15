// test/modDerive.test.js — 通道表的纯函数派生：必须与 `server/lobby.js` 原先的就地循环**逐项等价**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { derivePackChannels, deriveServerChannels } from '../server/mod-manager/derive.js';

/** 就地版本（重构前的实现，逐字抄来当参照）。 */
function legacyPackChannels(panels) {
  const map = new Map();
  for (const panel of (Array.isArray(panels) ? panels : [])) {
    if (!panel || typeof panel.pack !== 'string' || !Array.isArray(panel.messages)) continue;
    if (!map.has(panel.pack)) map.set(panel.pack, new Set());
    for (const channel of panel.messages) map.get(panel.pack).add(channel);
  }
  return map;
}
function legacyServerChannels(workshop) {
  const map = new Map();
  const declared = workshop && workshop.serverChannels;
  if (declared instanceof Map) {
    for (const [packId, channels] of declared) {
      if (typeof packId === 'string' && channels) map.set(packId, new Set(channels));
    }
  }
  return map;
}

const sameMap = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const k of a.keys()) assert.deepEqual([...a.get(k)].sort(), [...b.get(k)].sort(), `通道集合不同: ${k}`);
};

test('derivePackChannels ≡ 就地循环（含形状坏的条目、重复通道、多面板同包）', () => {
  const panels = [
    { pack: 'a', messages: ['chat', 'ping'] },
    { pack: 'a', messages: ['chat', 'extra'] },   // 同包第二个面板 + 重复通道
    { pack: 'b', messages: [] },                   // 空 messages：建空集合
    { pack: 'c' },                                 // 无 messages ⇒ 跳过
    { messages: ['x'] },                           // 无 pack ⇒ 跳过
    null, undefined, 'nope', 42,                  // 垃圾 ⇒ 跳过
    { pack: 'd', messages: ['m', 'm'] },           // 去重
  ];
  sameMap(derivePackChannels(panels), legacyPackChannels(panels));
  assert.deepEqual([...derivePackChannels(panels).get('d')], ['m']);
  assert.deepEqual([...derivePackChannels(panels).get('b')], []);
});

test('derivePackChannels：无包/非数组 ⇒ 空表（干净安装不变）', () => {
  assert.equal(derivePackChannels(undefined).size, 0);
  assert.equal(derivePackChannels(null).size, 0);
  assert.equal(derivePackChannels({}).size, 0);
  assert.equal(derivePackChannels([]).size, 0);
});

test('deriveServerChannels ≡ 就地浅拷贝，且**不共享**可变 Set', () => {
  const declared = new Map();
  declared.set('a', ['chan1', 'chan2']);
  declared.set('b', new Set(['z']));
  declared.set('', ['bad']);
  const got = deriveServerChannels(declared);
  sameMap(got, legacyServerChannels({ serverChannels: declared }));
  assert.ok(got.has(''), '与旧实现一致：判据是 typeof packId === "string"，空串也会被收下');
  assert.notEqual(got.get('a'), declared.get('a'), '必须是新建的 Set（浅拷贝语义）');
  declared.get('a').push('late');
  assert.deepEqual([...got.get('a')], ['chan1', 'chan2'], '源变化不影响已派生的表');
});

test('deriveServerChannels：非 Map / undefined ⇒ 空表', () => {
  assert.equal(deriveServerChannels(undefined).size, 0);
  assert.equal(deriveServerChannels({}).size, 0);
  assert.equal(deriveServerChannels([['a', ['x']]]).size, 0, '数组不是 Map ⇒ 空表（与旧 instanceof 判据一致）');
});
