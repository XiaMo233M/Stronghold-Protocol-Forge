// mod-xie/client/econ.js — 促融共竞的对局内 HUD（`screen.game.hud` 面板）。
//
// v2.1（业主 2026-10-12）：
//   · **借钱按钮 = 广播**：一次问遍其余三人；三人各自可借 1；一人同意不关掉别人的提示（其余的不自动关闭）。
//   · **喊话气泡**：谁在借钱，就在**他头像框右侧**挂一句随机喊话（句子由服务端随那条广播下发，全房同一句）。
//   · **同意按钮与借钱按钮同款**：琥珀描边、悬停抬升 —— 面板里的动作按钮共用一套样式。
//   · **复活 = 全体队友同意**（每人从共享池扣 5/10/15…）；**升级 = 一个人发起、其余人同意**。
//
// 注入面就是引擎给的那一份：`host` / `net(on,send)` / `me` / `data` / `log`。**没有 store、没有 match** ——
// 界面读的状态全部来自引擎推给这一端的 `m.public` / `m.private` 两帧（本包的服务端在视图里加了 `econ`）。
// v2 的形态（面板读一套键、服务端发另一套）就是「三个按钮点不了」的根因，所以这里的键与服务端**逐键对应**。

const CSS = `
.modxie-econ{position:absolute;left:8px;top:8px;z-index:40;font:12px/1.5 system-ui,sans-serif;color:#e8efec;
  background:rgba(6,10,9,.62);border:1px solid #2f3a36;border-radius:6px;padding:4px 8px;max-width:380px;pointer-events:auto}
.modxie-econ b{color:#f6a329}
.modxie-econ .row{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.modxie-econ .btn{margin:1px 2px;padding:1px 8px;font:11px/1.6 inherit;color:#f6a329;background:rgba(8,11,10,.9);
  border:1px solid #f6a329;border-radius:5px;cursor:pointer}
.modxie-econ .btn:hover{background:rgba(246,163,41,.16)}
.modxie-econ .btn:disabled{opacity:.45;cursor:default}
.modxie-econ .btn.quiet{color:#9fb0a9;border-color:#41504a}
.modxie-econ .note{color:#9fb0a9}
.modxie-ask{position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%);white-space:nowrap;
  background:rgba(8,11,10,.92);border:1px solid #f6a329;border-radius:8px;color:#f6a329;
  font:11px/1.4 system-ui,sans-serif;padding:2px 7px;pointer-events:none;z-index:60}
.modxie-ask::before{content:'';position:absolute;left:-5px;top:50%;transform:translateY(-50%);
  border:4px solid transparent;border-right-color:#f6a329}
`;

export function mount(ctx) {
  const doc = ctx.host.ownerDocument;
  if (!doc.getElementById('modxie-econ-css')) {
    const st = doc.createElement('style');
    st.id = 'modxie-econ-css';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }
  const box = doc.createElement('div');
  box.className = 'modxie-econ';
  ctx.host.appendChild(box);

  const state = { pub: null, priv: null };
  const send = (channel, data) => ctx.net.send(channel, data);
  const meId = () => (ctx.me && ctx.me.playerId) || null;
  const nameOf = (id) => {
    const players = state.pub && Array.isArray(state.pub.players) ? state.pub.players : [];
    const hit = players.find((p) => p && p.playerId === id);
    return (hit && hit.name) || id;
  };

  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  /** 与借钱按钮同款的动作钮（业主：「同意按钮 ui 和借钱按钮 ui 类似」）。 */
  const button = (label, onClick, { quiet = false, disabled = false, title = '' } = {}) => {
    const b = el('button', `btn${quiet ? ' quiet' : ''}`, label);
    b.type = 'button';
    if (disabled) b.disabled = true;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  /** 喊话气泡：挂在喊话人**头像框右侧**（`.team__row` 是引擎自己的相对定位容器）；找不到那一行就不挂。 */
  function syncBubbles(requests) {
    for (const n of [...doc.querySelectorAll('.modxie-ask')]) n.remove();
    if (!requests || !requests.length) return;
    for (const req of requests) {
      const who = nameOf(req.from);
      const rows = [...doc.querySelectorAll('.team__row, .team__btn')];
      const row = rows.find((r) => (r.textContent || '').includes(who));
      if (!row) continue;
      const mine = req.from === meId();
      const tag = el('span', 'modxie-ask', `${req.phrase || '借我一块钱！'}${mine ? '（你）' : ''}`);
      row.appendChild(tag);
    }
  }

  function render() {
    box.textContent = '';
    const pub = state.pub && state.pub.econ;
    const priv = state.priv && state.priv.econ;
    const revival = state.pub ? state.pub.revival : null;
    syncBubbles(pub && Array.isArray(pub.requests) ? pub.requests : []);
    if (!pub && !priv) { box.textContent = '促融共竞'; return; }

    const line = (text) => { const d = el('div', 'note', text); box.appendChild(d); return d; };
    if (pub) line(`共享池 ${pub.reserve ?? 0} · 本回合可借出 ${pub.transferLeft ?? 0}`);
    if (priv) {
      line(`我的资金 ${priv.funds ?? '?'}${priv.owe ? ` · 欠 ${priv.owe.total}` : ''}${priv.due ? ` · 应收 ${priv.due.total}` : ''}`);

      // 别人向我借（广播：一条三人都能看到；答复过的会从列表里消失）
      for (const req of priv.requestIn || []) {
        const row = el('div', 'row');
        row.appendChild(el('span', null, `${req.fromName || nameOf(req.from)}：${req.phrase || '借我一块'} `));
        row.appendChild(button('同意', () => send('answer', { id: req.id, approve: true }), { title: '借出 1 资金（下回合收回）' }));
        row.appendChild(button('拒绝', () => send('answer', { id: req.id, approve: false }), { quiet: true }));
        box.appendChild(row);
      }

      // 我的广播（进度：谁已经借了）
      for (const req of priv.myRequests || []) {
        line(`已广播借钱 ${req.amount}：${req.lent.length ? `${req.lent.join('、')} 已借` : '等应答'}（${req.answered}/${req.targets}）`);
      }

      // 动作行：借钱（广播）/ 救济 / 后勤项目（升级提案）
      const actions = el('div', 'row');
      const canBorrow = (priv.requestLeft || 0) > 0;
      actions.appendChild(button(`借钱 ${priv.maxPerRequest ?? 1}`, () => send('borrow', { amount: priv.maxPerRequest ?? 1 }), {
        disabled: !canBorrow, title: canBorrow ? '向其余队友广播求助（每人可借 1）' : '本回合的广播次数已用完',
      }));
      if (priv.relief) {
        actions.appendChild(button(`救济 ${priv.relief.left}`, () => send('relief', {}), {
          disabled: priv.relief.eligible === false || priv.relief.left <= 0,
          title: `全队生命值最低且 ≤ ${priv.relief.threshold} 时可领`,
        }));
      }
      for (const p of priv.projects || []) {
        actions.appendChild(button(`${p.id} Lv${p.level}/${p.max}${p.maxed ? '' : `（${p.cost}）`}`, () => send('project', { project: p.id }), {
          disabled: p.maxed || !p.affordable || priv.canPropose === false,
          title: p.maxed ? '已满级' : priv.canPropose === false ? '已有提案在等队友同意' : '发起升级：等全体队友同意后从共享池扣款',
        }));
      }
      box.appendChild(actions);

      // 升级提案：我来表态
      if (priv.vote) {
        const row = el('div', 'row');
        row.appendChild(el('span', null, `${priv.vote.byName} 提议升级 ${priv.vote.project} → Lv${priv.vote.level + 1}（池付 ${priv.vote.cost}） `));
        row.appendChild(button('同意', () => send('vote', { id: priv.vote.id, approve: true })));
        row.appendChild(button('拒绝', () => send('vote', { id: priv.vote.id, approve: false }), { quiet: true }));
        box.appendChild(row);
      }
    }

    // 救援：全体队友同意（每人从共享池扣 costPer）
    if (revival && revival.open && Array.isArray(revival.targets) && revival.targets.length) {
      const mine = meId();
      for (const t of revival.targets) {
        const need = Array.isArray(t.need) ? t.need : [];
        const agreed = Array.isArray(t.agreed) ? t.agreed : [];
        const row = el('div', 'row');
        row.appendChild(el('span', null, `救援 ${t.name}：${agreed.length}/${need.length} 人已同意（每人 ${revival.costPer}，共享池 ${revival.pool}） `));
        if (need.includes(mine) && !agreed.includes(mine)) {
          row.appendChild(button('同意救援', () => send('revive', { playerId: t.playerId }), { title: '全体队友同意后他被救回' }));
        }
        box.appendChild(row);
      }
    }
  }

  const onPub = ctx.net.on('m.public', (view) => { state.pub = view || null; render(); });
  const onPriv = ctx.net.on('m.private', (view) => { state.priv = view || null; render(); });
  render();

  return {
    unmount() {
      onPub();
      onPriv();
      for (const n of [...doc.querySelectorAll('.modxie-ask')]) n.remove();
      box.remove();
    },
  };
}
