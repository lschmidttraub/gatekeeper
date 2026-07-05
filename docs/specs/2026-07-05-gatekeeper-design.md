# Gatekeeper — Design Spec

**Date:** 2026-07-05
**Status:** Approved, building

A Chrome/Brave Manifest V3 extension (vanilla JS, no build step) that enforces
intentional browsing. Gated sites are intercepted before they load; access
requires a stated reason and a bounded timer. Anti-circumvention friction
escalates with repeated use. Everything is logged locally; nothing leaves the machine.

## Target browser

Primary target is **Brave 150** (`/opt/brave.com/brave/brave-browser`), a
Chromium derivative implementing the standard `chrome.*` MV3 APIs. The code is
plain Chromium MV3, so it also runs unmodified in Chrome. End-to-end verification
runs against the real Brave binary via `puppeteer-core`.

## Interception (the core mechanism)

Two layers, because neither alone covers all cases:

1. **declarativeNetRequest (DNR) dynamic redirect rule** — the hard pre-load
   block. One rule per gated host *that has no active session*, redirecting
   `main_frame` requests to `prompt/prompt.html`. Fires at the network layer, so
   no gated content ever paints. `requestDomains: [host]` matches subdomains
   automatically (satisfies "subdomains match automatically").
2. **webNavigation.onHistoryStateUpdated + tabs.onUpdated** — the SPA safety net.
   YouTube navigates via `history.pushState` with no new `main_frame` request, so
   DNR is blind to it. These listeners redirect in-app navigations on a blocked
   host to the prompt. This is what stops "click around YouTube after expiry."

`webNavigation.onBeforeNavigate` captures the exact intended URL (incl. fragment)
per tab so **Continue** restores it precisely. The prompt page fetches its target
from the service worker (with short retries) rather than from the redirect URL —
this keeps URLs exact and avoids DNR URL-encoding pitfalls.

## Files

```
manifest.json
background/service-worker.js   ES-module SW: lifecycle, alarms, DNR, badge, messaging
lib/common.js                  pure helpers: host matching, friction math, badge format, validation
prompt/  prompt.html .css .js  full-screen gate + reprompt/reflection page
options/ options.html .css .js gated-list editor, stats, log table
icons/   icon{16,32,48,128}.png  lock icon (rendered from icon.svg)
test/    e2e.mjs package.json  puppeteer-core harness pointed at Brave
README.md
```

Permissions: `storage`, `alarms`, `tabs`, `webNavigation`, `declarativeNetRequest`;
`host_permissions: ["<all_urls>"]` (gated hosts are user-editable at runtime).

## State (chrome.storage.local — all local)

- `config`: `{ gatedHosts[], hardCapMinutes:30, baseCooldownSec:30, baseMinChars:10, minWords:3, frictionWindowHours:2, quickMinutes:[2,5,10,15] }`
- `sessions{host}`: active only — `{ host, reason, requestedMinutes, startedAt, expiresAt, k }`
- `cooldowns{host}`: `{ until, k }`
- `starts{host}[]`: session start timestamps, pruned to the rolling window (friction count)
- `logs[]`: capped 200 — `{ id, ts, host, reason, requestedMinutes, outcome, fulfilled }`

Per-tab pending navigation targets live in `chrome.storage.session` as `target:<tabId>`.

## Session lifecycle (alarms are the source of truth)

- **Start**: validate → append start ts → write session → **remove** host's DNR
  block rule (await it) → `alarm expire:<host>` at `expiresAt` → update badge.
  Prompt then navigates the tab to the restored target.
- **Expiry** (alarm fires, or reconcile finds a stale deadline): log outcome →
  delete session → set cooldown (`baseCooldownSec × k`) → **re-add** DNR block →
  redirect every open tab on the host to the prompt (the reprompt) → update badge.
- **Reconcile** on `onInstalled` / `onStartup` / SW load: seed config if absent;
  rebuild DNR rules; expire any session with `expiresAt <= now`; re-arm alarms;
  refresh badge. This makes expiry survive service-worker suspension.

Alarms guarantee on-time expiry. The mm / m:ss **badge** countdown is a
best-effort refresh that runs while the SW is awake and on tab/navigation events;
badge accuracy never gates expiry correctness. Badge reflects the active tab's host session.

## Outcomes

- **cancelled** — "Never mind" at a prompt without starting a session (`requestedMinutes: null`).
- **completed** — expiry fired with ≥1 tab still open on the host (user stuck around).
- **abandoned_early** — expiry fired with no tabs open on the host (user left before time was up).
- **fulfilled** (reflection, optional) — captured from the reprompt's "was it
  fulfilled?" question, patched onto the just-ended session's log entry.

## Anti-circumvention math

Let **k = (sessions started on this host in the trailing `frictionWindowHours`) + 1**
(this session is the k-th in the window):

- Required reason length = `baseMinChars × k` (10, 20, 30, …), always **≥ `minWords`
  (3) distinct words** — kills `aaaaaaaaaa` (one word).
- Cooldown after the k-th session expires = `baseCooldownSec × k` seconds
  (30, 60, 90, …). The prompt shows a live countdown and keeps the form disabled
  until it reaches zero.

`k` is stored on the session at start and reused for its cooldown.

## Prompt & options

- **Prompt**: full-screen extension page, dark-mode via `prefers-color-scheme`,
  calm/no gamification. Host shown; reflection block if the last session here is
  unreflected; reason textarea with live "N / required chars, W distinct words"
  counter; duration number input (1–30) + quick buttons; Continue
  (Cmd/Ctrl+Enter) restores the exact target; Never mind (Esc) logs cancelled and
  closes the tab. Active cooldown disables the form with a countdown.
- **Options**: edit gated list (re-syncs DNR rules via `storage.onChanged`);
  per-host stats today (sessions, minutes, cancel rate); log table of the last 200.

## Verification (puppeteer-core → Brave, headless)

Local Node http server + `--host-resolver-rules` maps `gated.test` → 127.0.0.1 so
tests never touch the real network. Headline test mirrors the acceptance script:
start a 1-minute session → assert badge counts down → open a second tab on the
host → at expiry assert **all** host tabs redirect to the prompt → assert an
instant restart is blocked by the cooldown. Small `self.gatekeeper.*` hooks on the
SW let the harness drive deterministically. Verification runs in real Brave to
confirm Brave Shields doesn't interfere with the extension's DNR redirect.
