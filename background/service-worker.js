// Gatekeeper — MV3 service worker.
// Owns: DNR block rules, alarms (source of truth for expiry), the countdown badge,
// navigation interception, session lifecycle, and messaging with the prompt/options
// pages. All persistent state lives in chrome.storage.local; per-tab navigation
// targets live in chrome.storage.session.

import {
  DEFAULT_CONFIG,
  hostMatches,
  matchGatedHost,
  hostFromUrl,
  isHttpUrl,
  pageKey,
  isExcluded,
  windowMs,
  pruneStarts,
  requiredReasonChars,
  cooldownSeconds,
  validateReason,
  clampMinutes,
  formatBadge,
} from '../lib/common.js';

const BADGE_COLOR = '#b45309';
const MAX_LOGS = 200;

// --- Storage helpers -------------------------------------------------------

async function readAll() {
  const d = await chrome.storage.local.get([
    'config',
    'sessions',
    'cooldowns',
    'starts',
    'logs',
    'exclusions',
  ]);
  return {
    config: { ...DEFAULT_CONFIG, ...(d.config || {}) },
    sessions: d.sessions || {},
    cooldowns: d.cooldowns || {},
    starts: d.starts || {},
    logs: d.logs || [],
    exclusions: d.exclusions || [],
  };
}

async function ensureConfig() {
  const { config } = await chrome.storage.local.get('config');
  if (!config) await chrome.storage.local.set({ config: DEFAULT_CONFIG });
}

async function appendLog(entry) {
  const { logs } = await chrome.storage.local.get('logs');
  const arr = logs || [];
  entry.id = (arr.length ? Math.max(...arr.map((e) => e.id || 0)) : 0) + 1;
  arr.push(entry);
  while (arr.length > MAX_LOGS) arr.shift();
  await chrome.storage.local.set({ logs: arr });
}

// Per-tab intended navigation target (survives SW suspension via storage.session).
async function setTarget(tabId, url) {
  if (tabId == null) return;
  await chrome.storage.session.set({ ['target:' + tabId]: url });
}
async function getTarget(tabId) {
  if (tabId == null) return null;
  const key = 'target:' + tabId;
  const d = await chrome.storage.session.get(key);
  return d[key] || null;
}
async function clearTarget(tabId) {
  if (tabId == null) return;
  await chrome.storage.session.remove('target:' + tabId);
}

function promptUrl() {
  return chrome.runtime.getURL('prompt/prompt.html');
}

// --- DNR rules -------------------------------------------------------------

// One redirect rule per gated host that currently has no active session.
// requestDomains matches subdomains automatically.
const ALLOW_RULE_BASE = 1000; // exclusion allow-rule IDs live above the block-rule IDs

async function rebuildDnrRules() {
  const { config, sessions, exclusions } = await readAll();
  const now = Date.now();
  const blocked = config.gatedHosts.filter((h) => {
    const s = sessions[h];
    return !(s && s.expiresAt > now);
  });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = blocked.map((host, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: '/prompt/prompt.html' } },
    condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
  }));

  // Allow-exceptions for excluded pages on gated hosts. priority 2 (> block's 1)
  // and 'allow' both outrank the redirect, so the exact page loads with no flash.
  // urlFilter '|<page>^': '|' anchors the URL start, '^' matches a separator or
  // end-of-URL, so query variants match but a longer sibling path (…/1234) doesn't.
  let allowId = ALLOW_RULE_BASE;
  for (const e of exclusions) {
    if (!e || !e.page) continue;
    if (!matchGatedHost(hostFromUrl(e.page), config.gatedHosts)) continue;
    addRules.push({
      id: allowId++,
      priority: 2,
      action: { type: 'allow' },
      condition: { urlFilter: '|' + e.page + '^', resourceTypes: ['main_frame'] },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// --- Alarms ----------------------------------------------------------------

function alarmName(host) {
  return 'expire:' + host;
}
async function armAlarm(host, when) {
  await chrome.alarms.create(alarmName(host), { when });
}

// --- Badge -----------------------------------------------------------------

let badgeTimer = null;

async function updateBadgeForActiveTab() {
  let text = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && isHttpUrl(tab.url)) {
      const { config, sessions } = await readAll();
      const gated = matchGatedHost(hostFromUrl(tab.url), config.gatedHosts);
      const s = gated && sessions[gated];
      if (s && s.expiresAt > Date.now()) {
        text = formatBadge(s.expiresAt - Date.now());
      }
    }
  } catch {
    // no focused window / query failed — clear badge
  }
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

// Best-effort per-second refresh while the SW is awake and a session is active.
// The alarm — not this timer — guarantees expiry.
function scheduleBadgeTick() {
  if (badgeTimer) return;
  const tick = async () => {
    badgeTimer = null;
    await updateBadgeForActiveTab();
    const { sessions } = await readAll();
    const anyActive = Object.values(sessions).some((s) => s.expiresAt > Date.now());
    if (anyActive) badgeTimer = setTimeout(tick, 1000);
  };
  badgeTimer = setTimeout(tick, 1000);
}

// --- Session lifecycle -----------------------------------------------------

async function startSession(actualHost, reason, minutes) {
  const now = Date.now();
  const all = await readAll();
  const gated = matchGatedHost(actualHost, all.config.gatedHosts);
  if (!gated) return { ok: false, error: 'This site is not gated.' };

  const cd = all.cooldowns[gated];
  if (cd && cd.until > now) {
    return { ok: false, error: 'Cooldown is still active.', cooldownUntil: cd.until };
  }

  const mins = clampMinutes(minutes, all.config);
  if (mins == null) {
    return { ok: false, error: `Enter a duration between 1 and ${all.config.hardCapMinutes} minutes.` };
  }

  const starts = pruneStarts(all.starts[gated] || [], now, windowMs(all.config));
  const k = starts.length + 1;
  const v = validateReason(reason, k, all.config);
  if (!v.ok) return { ok: false, error: v.error };

  starts.push(now);
  all.starts[gated] = starts;
  all.sessions[gated] = {
    host: gated,
    reason: reason.trim(),
    requestedMinutes: mins,
    startedAt: now,
    expiresAt: now + mins * 60000,
    k,
  };
  delete all.cooldowns[gated];
  await chrome.storage.local.set({
    starts: all.starts,
    sessions: all.sessions,
    cooldowns: all.cooldowns,
  });

  await rebuildDnrRules(); // must finish before the prompt navigates to the target
  await armAlarm(gated, all.sessions[gated].expiresAt);
  scheduleBadgeTick();
  await updateBadgeForActiveTab();
  return { ok: true };
}

async function handleExpiry(gated) {
  const now = Date.now();
  const all = await readAll();
  const s = all.sessions[gated];
  if (!s) return; // already handled

  const tabs = await chrome.tabs.query({});
  // Only non-excluded tabs get reprompted; excluded research pages stay open and
  // don't count as "still here" for the outcome.
  const hostTabs = tabs.filter(
    (t) => hostMatches(gated, hostFromUrl(t.url)) && !isExcluded(t.url, all.exclusions)
  );
  const outcome = hostTabs.length > 0 ? 'completed' : 'abandoned_early';

  await appendLog({
    ts: now,
    host: gated,
    reason: s.reason,
    requestedMinutes: s.requestedMinutes,
    outcome,
    fulfilled: null,
  });

  delete all.sessions[gated];
  all.cooldowns[gated] = { until: now + cooldownSeconds(s.k, all.config) * 1000, k: s.k };
  await chrome.storage.local.set({ sessions: all.sessions, cooldowns: all.cooldowns });

  await chrome.alarms.clear(alarmName(gated));
  await rebuildDnrRules(); // re-add the block

  // Reprompt: redirect every open tab on this host back to the prompt.
  for (const t of hostTabs) {
    await setTarget(t.id, t.url);
    try {
      await chrome.tabs.update(t.id, { url: promptUrl() });
    } catch {
      /* tab may have closed */
    }
  }
  await updateBadgeForActiveTab();
}

async function cancelPrompt(actualHost, tabId) {
  const all = await readAll();
  const gated = matchGatedHost(actualHost, all.config.gatedHosts) || actualHost || 'unknown';
  await appendLog({
    ts: Date.now(),
    host: gated,
    reason: '',
    requestedMinutes: null,
    outcome: 'cancelled',
    fulfilled: null,
  });
  await clearTarget(tabId);
  try {
    if (tabId != null) await chrome.tabs.remove(tabId);
  } catch {
    /* tab already gone */
  }
  return { ok: true };
}

// Permanently allow-list a specific page (origin + path). Logged, then the DNR
// allow-exception is installed so the page loads without gating.
async function excludePage(actualHost, url) {
  const key = pageKey(url);
  if (!key) return { ok: false, error: 'This page cannot be allowed.' };
  const all = await readAll();
  const gated = matchGatedHost(hostFromUrl(url), all.config.gatedHosts) || actualHost || hostFromUrl(url);
  if (!all.exclusions.some((e) => e.page === key)) {
    all.exclusions.push({ host: gated, page: key, addedAt: Date.now() });
    await chrome.storage.local.set({ exclusions: all.exclusions });
  }
  await rebuildDnrRules(); // install the allow rule before the prompt navigates
  await appendLog({
    ts: Date.now(),
    host: gated,
    reason: '',
    requestedMinutes: null,
    outcome: 'excluded',
    fulfilled: null,
  });
  return { ok: true };
}

// Patch the "was it fulfilled?" reflection onto the most recent ended session
// for this host that hasn't been reflected yet.
async function reflectFulfilled(gated, fulfilled) {
  const { logs } = await chrome.storage.local.get('logs');
  const arr = logs || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e.host === gated && (e.outcome === 'completed' || e.outcome === 'abandoned_early') && e.fulfilled == null) {
      e.fulfilled = !!fulfilled;
      await chrome.storage.local.set({ logs: arr });
      return { ok: true };
    }
  }
  return { ok: false };
}

async function getPromptState(actualHost) {
  const now = Date.now();
  const all = await readAll();
  const gated = matchGatedHost(actualHost, all.config.gatedHosts);
  if (!gated) return { gated: false };

  const starts = pruneStarts(all.starts[gated] || [], now, windowMs(all.config));
  const k = starts.length + 1;
  const cd = all.cooldowns[gated];
  const cooldownUntil = cd && cd.until > now ? cd.until : 0;

  let prevReason = '';
  let awaitingReflection = false;
  for (let i = all.logs.length - 1; i >= 0; i--) {
    const e = all.logs[i];
    if (e.host === gated && (e.outcome === 'completed' || e.outcome === 'abandoned_early')) {
      prevReason = e.reason || '';
      awaitingReflection = e.fulfilled == null;
      break;
    }
  }

  return {
    gated: true,
    host: gated,
    k,
    requiredChars: requiredReasonChars(k, all.config),
    minWords: all.config.minWords,
    hardCapMinutes: all.config.hardCapMinutes,
    quickMinutes: all.config.quickMinutes,
    baseMinChars: all.config.baseMinChars,
    cooldownUntil,
    prevReason,
    awaitingReflection,
  };
}

// Redirect any already-open tab that sits on a gated, session-less host.
async function enforceOpenTabs() {
  const all = await readAll();
  const now = Date.now();
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!isHttpUrl(t.url)) continue;
    const gated = matchGatedHost(hostFromUrl(t.url), all.config.gatedHosts);
    if (!gated) continue;
    if (isExcluded(t.url, all.exclusions)) continue;
    const s = all.sessions[gated];
    if (s && s.expiresAt > now) continue;
    await setTarget(t.id, t.url);
    try {
      await chrome.tabs.update(t.id, { url: promptUrl() });
    } catch {
      /* ignore */
    }
  }
}

// --- Reconcile (self-heal on wake / startup / install) ---------------------

async function reconcile() {
  await ensureConfig();
  const now = Date.now();
  const all = await readAll();
  for (const host of Object.keys(all.sessions)) {
    if (all.sessions[host].expiresAt <= now) {
      await handleExpiry(host);
    } else {
      await armAlarm(host, all.sessions[host].expiresAt);
    }
  }
  await rebuildDnrRules();
  scheduleBadgeTick();
  await updateBadgeForActiveTab();
}

// --- SPA interception net --------------------------------------------------

async function maybeRedirectSpa(details) {
  if (details.frameId !== 0) return;
  if (!isHttpUrl(details.url)) return;
  const all = await readAll();
  const gated = matchGatedHost(hostFromUrl(details.url), all.config.gatedHosts);
  if (!gated) return;
  if (isExcluded(details.url, all.exclusions)) return; // allow-listed page
  const s = all.sessions[gated];
  if (s && s.expiresAt > Date.now()) return; // active session — allow
  // Blocked host navigating via history API — DNR can't see this. Redirect.
  await setTarget(details.tabId, details.url);
  try {
    await chrome.tabs.update(details.tabId, { url: promptUrl() });
  } catch {
    /* ignore */
  }
}

// --- Event wiring ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  reconcile();
});
chrome.runtime.onStartup.addListener(() => {
  reconcile();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('expire:')) {
    handleExpiry(alarm.name.slice('expire:'.length));
  }
});

// Capture the intended URL for a blocked full-page navigation. DNR does the
// actual redirect; we just record the target so Continue can restore it exactly.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0 || !isHttpUrl(details.url)) return;
  const all = await readAll();
  const gated = matchGatedHost(hostFromUrl(details.url), all.config.gatedHosts);
  if (!gated) return;
  if (isExcluded(details.url, all.exclusions)) return;
  const s = all.sessions[gated];
  if (s && s.expiresAt > Date.now()) return;
  await setTarget(details.tabId, details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(maybeRedirectSpa);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(maybeRedirectSpa);

// Fallback: catch a blocked host that slipped past DNR (e.g. rules not yet
// synced). Also drives the badge on the active tab. Guarded to actual URL
// changes so it can't loop on the extension prompt page.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && isHttpUrl(changeInfo.url)) {
    const all = await readAll();
    const gated = matchGatedHost(hostFromUrl(changeInfo.url), all.config.gatedHosts);
    if (gated && !isExcluded(changeInfo.url, all.exclusions)) {
      const s = all.sessions[gated];
      if (!(s && s.expiresAt > Date.now())) {
        await setTarget(tabId, changeInfo.url);
        try {
          await chrome.tabs.update(tabId, { url: promptUrl() });
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }
  if (tab && tab.active && (changeInfo.url || changeInfo.status)) {
    updateBadgeForActiveTab();
  }
});

chrome.tabs.onActivated.addListener(() => {
  updateBadgeForActiveTab();
});
chrome.windows.onFocusChanged.addListener(() => {
  updateBadgeForActiveTab();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTarget(tabId);
});

// Re-sync DNR + gate open tabs when the gated list changes in Options.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.config) {
    await rebuildDnrRules();
    await enforceOpenTabs();
    await updateBadgeForActiveTab();
  }
});

// --- Messaging -------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab ? sender.tab.id : null;
    try {
      switch (msg && msg.type) {
        case 'getTarget':
          sendResponse({ target: await getTarget(tabId) });
          break;
        case 'getPromptState':
          sendResponse(await getPromptState(msg.host));
          break;
        case 'startSession': {
          const r = await startSession(msg.host, msg.reason, msg.minutes);
          if (r.ok) await clearTarget(tabId);
          sendResponse(r);
          break;
        }
        case 'cancelPrompt':
          sendResponse(await cancelPrompt(msg.host, tabId));
          break;
        case 'excludePage': {
          const r = await excludePage(msg.host, msg.url);
          if (r.ok) await clearTarget(tabId);
          sendResponse(r);
          break;
        }
        case 'reflectFulfilled':
          sendResponse(await reflectFulfilled(msg.host, msg.fulfilled));
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// --- Test hooks ------------------------------------------------------------
// Deterministic entry points for the Puppeteer harness. Harmless in production.
self.gatekeeper = {
  startSession,
  handleExpiry,
  reconcile,
  rebuildDnrRules,
  getPromptState,
  reflectFulfilled,
  excludePage,
  readAll,
  updateBadgeForActiveTab,
  promptUrl,
  async _resetAll() {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await ensureConfig();
    await rebuildDnrRules();
  },
  async _setConfig(cfg) {
    await chrome.storage.local.set({ config: { ...DEFAULT_CONFIG, ...cfg } });
    await reconcile();
  },
  async _getBadgeText() {
    return chrome.action.getBadgeText({});
  },
  // Simulate "session ended, host re-blocked" while leaving open tabs untouched,
  // so a test can verify the SPA net redirects a subsequent history navigation.
  async _blockHostQuiet(host) {
    const all = await readAll();
    delete all.sessions[host];
    all.cooldowns[host] = { until: Date.now() + 30000, k: 1 };
    await chrome.storage.local.set({ sessions: all.sessions, cooldowns: all.cooldowns });
    await chrome.alarms.clear(alarmName(host));
    await rebuildDnrRules();
  },
};

// Self-heal whenever the worker wakes.
reconcile();
