// #603: the shipped CHANGELOG is the source; unreleased/future sections are never shown for an older binary.
export const RELEASE_SEEN_PREFIX = 'sp.pref.release-seen.';

export function releaseSections(markdown, version) {
  const sections = [];
  let current;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) fenced = !fenced;
    // 版本号两种都收：上游的 `x.y.z`，以及本仓库的「我们的版本-上游版本」（0.22.0-0.4.0）
    const heading = !fenced && line.match(/^## (\d+\.\d+\.\d+(?:-\d+\.\d+\.\d+)?)(?:-dev)? — (.+)$/);
    if (heading) {
      current = { version: heading[1], title: line.slice(3), body: '' };
      sections.push(current);
    } else if (current) current.body += `${line}\n`;
  }
  const running = version.replace(/-dev$/, '');
  // 本仓库的 CHANGELOG 条目写「0.22.0-0.4.0」而 APP_VERSION 是 0.22.0：前缀算同一节
  const index = sections.findIndex((s) => s.version === running || s.version.startsWith(`${running}-`));
  return index < 0 ? [] : sections.slice(index);
}

// Only links to http(s), or repository documents resolved against GitHub; no raw HTML is ever rendered.
export function releaseLink(raw) {
  if (/^(?:https?:\/\/|(?:docs\/|README\.md|CHANGELOG\.md|NOTICE\.md))/.test(raw)) {
    try { return new URL(raw, 'https://github.com/sganggs/Stronghold-Protocol/blob/master/').href; } catch { /* text only */ }
  }
  return null;
}
