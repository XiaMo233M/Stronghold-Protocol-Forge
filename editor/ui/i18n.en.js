// editor/ui/i18n.en.js — 英文词典汇总：把各分片合成一张表交给 i18n.js。
//
// 分成多个文件是为了让「一页一个词条文件」：改某个页面时只碰那一个文件，几个页面同时改也不会互相覆盖。
// 加一个页面的词条就在这里 import 一行、在 EN_CHUNKS 里加一条。分片之间**不允许有重复键**
// （同一条中文在两个分片里各译一次，必然有一天只改了一处），test/editorI18n.test.js 会查这件事。

import { EN_SHARED } from './i18n.en.shared.js';
import { EN_INDEX } from './i18n.en.index.js';
import { EN_STAGE } from './i18n.en.stage.js';
import { EN_ENEMY } from './i18n.en.enemy.js';
import { EN_WAVE } from './i18n.en.wave.js';
import { EN_ITEM } from './i18n.en.item.js';
import { EN_KIT } from './i18n.en.kit.js';
import { EN_VOICE } from './i18n.en.voice.js';
import { EN_PACK } from './i18n.en.pack.js';
import { EN_BOND } from './i18n.en.bond.js';

/** 分片表：键是分片名（测试报告重复键时会指出是哪个分片），值是该分片的词条。 */
export const EN_CHUNKS = Object.freeze({
  shared: EN_SHARED,
  index: EN_INDEX,
  stage: EN_STAGE,
  enemy: EN_ENEMY,
  wave: EN_WAVE,
  item: EN_ITEM,
  kit: EN_KIT,
  voice: EN_VOICE,
  pack: EN_PACK,
  bond: EN_BOND,
});

export const EN = Object.freeze(Object.assign({}, ...Object.values(EN_CHUNKS)));
