// Gatekeeper — shared pure helpers.
// No chrome.* and no DOM here on purpose: this module is imported by the service
// worker, the prompt page, and the options page, and is exercised directly by the
// test harness. Keep everything here a pure function of its arguments.

export const DEFAULT_CONFIG = {
  gatedHosts: ['news.ycombinator.com', 'youtube.com'],
  hardCapMinutes: 30,
  baseCooldownSec: 30,
  baseMinChars: 10,
  minWords: 3,
  frictionWindowHours: 2,
  quickMinutes: [2, 5, 10, 15],
};

// --- Hostname matching -----------------------------------------------------

// A gated host matches the host itself and any subdomain of it.
// gated "youtube.com" matches "youtube.com", "www.youtube.com", "m.youtube.com".
export function hostMatches(gatedHost, actualHost) {
  if (!gatedHost || !actualHost) return false;
  gatedHost = gatedHost.toLowerCase();
  actualHost = actualHost.toLowerCase();
  return actualHost === gatedHost || actualHost.endsWith('.' + gatedHost);
}

// Returns the gated host string that matches actualHost, or null.
export function matchGatedHost(actualHost, gatedHosts) {
  if (!actualHost || !Array.isArray(gatedHosts)) return null;
  for (const g of gatedHosts) {
    if (hostMatches(g, actualHost)) return g;
  }
  return null;
}

export function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Extract hostname from a URL; null for non-http(s) or unparseable URLs.
export function hostFromUrl(url) {
  if (!isHttpUrl(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// A page's identity for exclusion purposes: origin + pathname, ignoring the
// query string and fragment. So x.com/a/1, x.com/a/1?s=20, and x.com/a/1#x are
// the same page, but x.com/a/12 is not. Returns null for non-http(s) URLs.
export function pageKey(url) {
  if (!isHttpUrl(url)) return null;
  try {
    const u = new URL(url);
    return u.origin.toLowerCase() + u.pathname;
  } catch {
    return null;
  }
}

// True if url is on the per-page allowlist. Matching is exact page-key equality
// (which already implies same scheme + host), so it can never widen to a whole host.
export function isExcluded(url, exclusions) {
  if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
  const key = pageKey(url);
  if (!key) return false;
  return exclusions.some((e) => e && e.page === key);
}

// Normalize user-entered gated-site input into a bare hostname.
// Accepts "https://YouTube.com/foo", "youtube.com", "www.youtube.com:443", etc.
export function normalizeHostInput(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (!s) return '';
  if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  try {
    return new URL(s).hostname;
  } catch {
    return '';
  }
}

// --- Friction math ---------------------------------------------------------

// k = number of sessions started on this host within the rolling window + 1.
export function windowMs(config) {
  return (config?.frictionWindowHours ?? DEFAULT_CONFIG.frictionWindowHours) * 3600 * 1000;
}

export function pruneStarts(starts, now, wMs) {
  if (!Array.isArray(starts)) return [];
  const cutoff = now - wMs;
  return starts.filter((t) => typeof t === 'number' && t >= cutoff);
}

export function sessionCountInWindow(starts, now, wMs) {
  return pruneStarts(starts, now, wMs).length;
}

// The k-value that applies to a session started *now* on this host.
export function nextK(starts, now, config) {
  return sessionCountInWindow(starts, now, windowMs(config)) + 1;
}

export function requiredReasonChars(k, config) {
  return (config?.baseMinChars ?? DEFAULT_CONFIG.baseMinChars) * k;
}

export function cooldownSeconds(k, config) {
  return (config?.baseCooldownSec ?? DEFAULT_CONFIG.baseCooldownSec) * k;
}

// --- Reason validation -----------------------------------------------------

// Count distinct words (case-insensitive, must contain a letter). "aaaaaaaaaa"
// is a single word, so it fails the >= minWords check regardless of length.
export function distinctWordCount(reason) {
  if (typeof reason !== 'string') return 0;
  const words = reason
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')) // strip punctuation
    .filter((w) => /\p{L}/u.test(w)); // must contain a letter
  return new Set(words).size;
}

// Returns { ok, error } for a proposed reason given the current k and config.
export function validateReason(reason, k, config) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  const need = requiredReasonChars(k, config);
  const minWords = config?.minWords ?? DEFAULT_CONFIG.minWords;
  if (text.length < need) {
    return { ok: false, error: `Reason must be at least ${need} characters (${text.length} so far).` };
  }
  const words = distinctWordCount(text);
  if (words < minWords) {
    return { ok: false, error: `Reason must use at least ${minWords} distinct words (${words} so far).` };
  }
  return { ok: true, error: '' };
}

export function clampMinutes(minutes, config) {
  const cap = config?.hardCapMinutes ?? DEFAULT_CONFIG.hardCapMinutes;
  const n = Math.floor(Number(minutes));
  if (!Number.isFinite(n)) return null;
  if (n < 1) return null;
  return Math.min(n, cap);
}

// --- Badge formatting ------------------------------------------------------

// >= 1 min: whole minutes remaining ("5"). Under 1 min: "m:ss" ("0:45").
export function formatBadge(remainingMs) {
  if (!(remainingMs > 0)) return '';
  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec >= 60) return String(Math.floor(totalSec / 60));
  return '0:' + String(totalSec).padStart(2, '0');
}

// --- Cooldown countdown text ----------------------------------------------

export function formatCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
