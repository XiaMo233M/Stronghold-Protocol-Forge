// test/modNoticesPanel.test.js — 公告 / 鸣谢**面板**的纯逻辑（DESIGN §28.15 的客户端那一半）。
//
// 面板本身是 Preact 组件，本机没有 Chrome（`SP_E2E=1` 才跑浏览器），所以这里跑的是它唯一的判断分支：把服务端的合并体
// 整理成「要画的东西」。客户端是**第二个读者**，最要紧的一条是**链接只认 `https://`** —— 一个包写 `javascript:` 或
// `http:` 不该变成页面上的一个可点链接（名字照旧展示，只是不能点）。
//
// Run: node --test test/modNoticesPanel.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { noticesView, NOTICE_LIMITS } from '../public/js/ui/notices.js';
import { DATA_FILES } from '../public/js/data.js';
import { CLIENT_PANEL_DATA_TABLES } from '../shared/workshop.js';

const good = (extra = {}) => ({ version: '1.0.0', date: '2026-10-10', summary: '摘要', sections: [], ...extra });

describe('noticesView：把合并体整理成要画的东西', () => {
  test('空 / 没到 / 形状不对 ⇒ 空视图（面板画一句「没有要展示的」而不是炸）', () => {
    for (const bad of [undefined, null, 0, 'x', [], {}]) {
      const v = noticesView(bad);
      assert.deepEqual(v, { announcements: [], credits: [] }, JSON.stringify(bad));
    }
    assert.deepEqual(noticesView({ announcements: 'x', credits: 7 }), { announcements: [], credits: [] });
  });

  test('合法的公告照原样整理出来（含包归属与小节）', () => {
    const v = noticesView({
      announcements: [{ pack: 'notice-pack', ...good({ sections: [{ name: '做了什么', items: ['一', ' 二 '] }] }) }],
    });
    assert.equal(v.announcements.length, 1);
    const a = v.announcements[0];
    assert.equal(a.pack, 'notice-pack');
    assert.equal(a.version, '1.0.0');
    assert.deepEqual(a.sections, [{ name: '做了什么', items: ['一', '二'] }], '空白要归一化');
    // 引擎那一条没有包归属
    assert.equal(noticesView({ announcements: [good()] }).announcements[0].pack, null);
  });

  test('少了 version 或 summary 的条目丢掉（不画半个）', () => {
    const v = noticesView({ announcements: [good({ version: '' }), good({ summary: '  ' }), good({ version: '2.0.0' })] });
    assert.deepEqual(v.announcements.map((a) => a.version), ['2.0.0']);
  });

  test('每一项都有上限：条数 / 小节 / 条目 / 字符', () => {
    const many = Array.from({ length: 30 }, (_, i) => good({ version: `1.0.${i}` }));
    assert.equal(noticesView({ announcements: many }).announcements.length, NOTICE_LIMITS.announcements);
    const sections = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, items: ['x'] }));
    const items = Array.from({ length: 60 }, (_, i) => `i${i}`);
    const v = noticesView({ announcements: [good({ sections: [{ name: 'a', items }, ...sections] })] });
    assert.equal(v.announcements[0].sections.length, NOTICE_LIMITS.sections);
    assert.equal(v.announcements[0].sections[0].items.length, NOTICE_LIMITS.items);
    assert.equal(noticesView({ announcements: [good({ summary: 'x'.repeat(700) })] }).announcements.length, 0, '超长摘要丢掉');
  });

  test('署名：名字必填、网址只认 https、按 名字|网址 去重', () => {
    const v = noticesView({
      credits: [
        { name: '甲', url: 'https://example.com/a' },
        { name: '甲', url: 'https://example.com/a' },          // 重复
        { name: '乙', url: 'javascript:alert(1)' },            // 不能点的网址：名字留下、网址丢掉
        { name: '丙', url: 'http://insecure.example.com' },    // http：同上
        { name: '丁', note: '说明' },
        { note: '没有名字' },                                   // 整条丢掉
        'x',
      ],
    });
    assert.deepEqual(v.credits.map((c) => c.name), ['甲', '乙', '丙', '丁']);
    assert.equal(v.credits[0].url, 'https://example.com/a');
    assert.equal(v.credits[1].url, '', 'javascript: 的网址被丢掉');
    assert.equal(v.credits[2].url, '', 'http 的网址被丢掉');
    assert.equal(v.credits[3].note, '说明');
  });

  test('署名也有条数上限', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `n${i}` }));
    assert.equal(noticesView({ credits: many }).credits.length, NOTICE_LIMITS.credits);
  });
});

describe('这一格在客户端的数据层里是可读的（面板与包的面板都能拿）', () => {
  test('`notices` 在 `DATA_FILES` 里，也在包面板可读的那张表里（两份名单钉在一起）', () => {
    assert.equal(DATA_FILES.notices, 'notices.json');
    assert.ok(CLIENT_PANEL_DATA_TABLES.includes('notices'), '包的面板也可以读它（例如想自己展示鸣谢）');
  });
});
