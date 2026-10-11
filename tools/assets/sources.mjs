// Upstream asset sources (GitHub dumps of the official client), URL helpers and
// local-path helpers shared by the asset pipeline (tools/fetch-assets.mjs).
//
// GitHub URLs support a prefix proxy and a jsDelivr fallback. jsDelivr does
// not serve the voice branch, but the prefix proxy can still be tried there.
// See docs/ASSETS.md for the full source list and credits.

export const DEFAULT_GITHUB_PROXY = 'https://gh-proxy.com/';

export function normalizeProxyPrefix(prefix = DEFAULT_GITHUB_PROXY) {
  if (prefix.trim() === '') return '';
  const url = new URL(prefix);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub proxy prefix must be an HTTPS URL without credentials, query or fragment');
  }
  return url.href.endsWith('/') ? url.href : url.href + '/';
}

function isGithubDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      ['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.host);
  } catch { return false; }
}

/**
 * Legacy ledgers store the successful proxy URL. Spine page jobs derived from
 * those URLs must use today's policy, not implicitly opt in to the old proxy.
 * Recognize embedded public GitHub URLs even when the old custom prefix is no
 * longer configured. An ordinary GitHub URL (including its path) stays intact.
 */
export function githubSourceUrl(url) {
  let candidate = String(url);
  while (candidate.startsWith('https://')) {
    if (isGithubDownloadUrl(candidate)) return candidate;
    const marker = candidate.indexOf('/https://', 8);
    if (marker < 0) break;
    candidate = candidate.slice(marker + 1);
  }
  return url;
}

/** Only public GitHub download URLs are sent to the proxy; never prefix twice. */
export function githubProxyUrl(url, prefix = DEFAULT_GITHUB_PROXY) {
  const normalized = normalizeProxyPrefix(prefix);
  if (!normalized || !isGithubDownloadUrl(url)) return null;
  return normalized + url;
}

/**
 * Ordered transport alternatives; direct mode retains the existing jsDelivr order.
 * `assetBase` (an override base, '' = today's behaviour) rewrites the raw.githubusercontent.com candidates onto that
 * base; the jsDelivr fallback is left as it is (it is not a raw URL, and a CDN override implies the operator wants that
 * host, not jsDelivr). Duplicates are removed, so a base that equals the default source collapses to one URL.
 * @param {string} url
 * @param {{source?:'direct'|'mirror', proxyPrefix?:string, assetBase?:string}} [opts]
 */
export function downloadUrls(url, { source = 'direct', proxyPrefix = DEFAULT_GITHUB_PROXY, assetBase = '' } = {}) {
  url = githubSourceUrl(url);
  const proxy = source === 'mirror' ? githubProxyUrl(url, proxyPrefix) : null;
  return [...new Set([proxy, url, mirrorUrl(url)].filter(Boolean))].map((u) => withAssetBase(u, assetBase));
}

/** Hosts whose plain HTTP is a local test source, not an untrusted network hop. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

/**
 * Is this base URL an untrusted source? Anything that is not HTTPS and does not point at loopback: a plaintext mirror
 * on the network, where a man in the middle can replace what lands in public/assets. Such a base is allowed for
 * downloading, but it must not be combined with a flag that SHRINKS the committed manifest (--prune / --allow-shrink):
 * untrusted bytes are one thing, a manifest missing the entries only another install has is a lasting one.
 * @param {string|undefined|null} base normalized base ('' = no override, which is trusted)
 * @returns {boolean}
 */
export function baseIsUntrusted(base) {
  if (!base) return false;
  try {
    const url = new URL(base);
    return url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname);
  } catch { return true; }
}

/**
 * The console warnings of a base URL override: a plaintext one on a real network host says what that means. Loopback
 * over HTTP is a local test source and warns about nothing.
 * @param {string} base normalized base ('' = nothing)
 * @param {string} flag `--asset-base` / `--index-base`
 * @returns {string[]} lines to print, empty when there is nothing to say
 */
export function baseWarnings(base, flag = '--asset-base') {
  if (!base) return [];
  try {
    if (new URL(base).protocol === 'https:') return [];
  } catch { return []; }
  if (LOOPBACK_HOSTS.has(new URL(base).hostname)) return [];
  return [
    `[network] 警告：${flag} ${base} 使用明文 HTTP：下载内容可被中间人替换，` +
    '而它会被写进 public/assets/ 并进 data/assets.json。非可信源不允许与 --prune / --allow-shrink 组合。',
  ];
}

/**
 * Validate a user-supplied base URL override (`--asset-base` / `--index-base`, `SP_ASSET_BASE` / `SP_INDEX_BASE`).
 * Malformed input is refused by name: a typo must never silently fall back to the default source (the run would then
 * quietly download from GitHub while the operator believes it is reading a CDN). `undefined`/`null`/empty means "no
 * override" and returns `''`.
 *
 * HTTPS and HTTP are both accepted (a LAN mirror is often plain HTTP — see `baseWarnings` for what a non-loopback
 * HTTP base prints, and `baseIsUntrusted` for the one combination that is refused); credentials, a query and a
 * fragment are not.
 * @param {string|undefined|null} value
 * @param {string} flag the flag/env var to name in the error (e.g. `--asset-base`)
 * @returns {string} normalized base ending with '/', or '' when unset
 */
export function normalizeAssetBase(value, flag = '--asset-base') {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (raw === '') return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error(`invalid ${flag} URL: ${raw} (an absolute URL, e.g. https://cdn.example.com/)`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`invalid ${flag} URL: ${raw} (must be http or https)`);
  }
  if (url.username || url.password) throw new Error(`invalid ${flag} URL: ${raw} (no credentials)`);
  if (url.search || url.hash) throw new Error(`invalid ${flag} URL: ${raw} (no query or fragment)`);
  return url.href.endsWith('/') ? url.href : url.href + '/';
}

/**
 * A public GitHub download URL is rewritten onto the override base by replacing
 * `raw.githubusercontent.com/` and keeping the repository path: the override mirrors the
 * `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` layout, so
 * `--asset-base=https://cdn.example.com/` turns that URL into
 * `https://cdn.example.com/<owner>/<repo>/<branch>/<path>`. Anything else (a jsDelivr mirror, a proxy URL, a data: URL,
 * a Spine page URL under some other host) is returned unchanged, and a URL that already starts with the base is not
 * prefixed twice.
 * @param {string} url
 * @param {string} base normalized override base ('' = no override)
 * @returns {string}
 */
export function withAssetBase(url, base) {
  if (!base) return url;
  const s = String(url);
  if (s.startsWith(base)) return s;
  const marker = 'https://raw.githubusercontent.com/';
  return s.startsWith(marker) ? base + s.slice(marker.length) : s;
}

/** Raw base URLs (always end with '/'). */
export const RAW = Object.freeze({
  yuanyan: 'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/',
  fexli: 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/',
  arkModels: 'https://raw.githubusercontent.com/isHarryh/Ark-Models/main/',
  aa2: 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/cn/assets/dyn/',
  aa2voice: 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/',
  fonts: 'https://raw.githubusercontent.com/TimWangZi/The-font-of-Arknights/master/font/',
  gamedata: 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/',
});

const RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;

/**
 * Map a raw.githubusercontent.com URL to its jsDelivr mirror.
 * @param {string} url
 * @returns {string|null} mirror URL, or null when no usable mirror exists
 */
export function mirrorUrl(url) {
  const m = RAW_RE.exec(String(url));
  if (!m) return null;
  const [, owner, repo, branch, path] = m;
  // jsDelivr does not serve the (huge) voice branch of ArknightsAssets2.
  if (owner === 'ArknightsAssets' && branch === 'voice') return null;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
}

/**
 * Percent-encode each segment of a repo-relative path ('[uc]x/a b.png' → '%5Buc%5Dx/a%20b.png').
 * @param {string} relPath
 * @returns {string}
 */
export function encodePath(relPath) {
  return String(relPath).split('/').map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Join a base URL and a *decoded* repo-relative path, encoding the path.
 * @param {string} base  base URL ending with '/'
 * @param {string} relPath decoded path
 * @returns {string}
 */
export function joinUrl(base, relPath) {
  return base + encodePath(relPath);
}

/**
 * Sanitize a single file-name component for local storage / URLs:
 * keeps [A-Za-z0-9._-], turns everything else (spaces, brackets, '#') into '_'.
 * @param {string} name
 * @returns {string}
 */
export function safeName(name) {
  const s = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return s.length ? s : '_';
}

/**
 * Site-root URL path for a file under public/assets.
 * @param {string} rel path relative to public/assets (forward slashes)
 * @returns {string} e.g. '/assets/char/avatar/char_002_amiya.png'
 */
export function assetUrl(rel) {
  return '/assets/' + rel;
}

/**
 * Directory part of a URL (everything up to and including the last '/').
 * @param {string} url
 * @returns {string}
 */
export function urlDir(url) {
  const i = String(url).lastIndexOf('/');
  return i >= 0 ? url.slice(0, i + 1) : '';
}

/**
 * Last path component of a URL, percent-decoded.
 * @param {string} url
 * @returns {string}
 */
export function urlBase(url) {
  const s = String(url).split('?')[0];
  const last = s.slice(s.lastIndexOf('/') + 1);
  try { return decodeURIComponent(last); } catch { return last; }
}
