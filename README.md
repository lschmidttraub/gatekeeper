# Gatekeeper

A Manifest V3 browser extension that enforces **intentional browsing**. Gated
sites are intercepted *before they load*; getting in requires typing a real
reason and a bounded timer. Repeated visits get progressively more friction.
Everything is logged locally — nothing ever leaves your machine.

Built as vanilla JS with **no build step**. Runs in **Brave** and Chrome (any
Chromium browser with Manifest V3).

## What it does

- **Gate a list of sites.** You maintain the hostnames (e.g. `news.ycombinator.com`,
  `youtube.com`). Subdomains match automatically.
- **Intercept before load.** Navigating to a gated site with no active session
  shows a full-screen prompt (a real extension page, not an injected overlay)
  asking *why* you're here and *for how long*.
- **Sessions are per-hostname, not per-tab.** Once a session is active, every tab
  on that host passes through freely. The toolbar **badge** shows the time left
  (minutes, or `m:ss` in the last minute).
- **Reprompt at expiry.** When time runs out, *every* open tab on that host is
  immediately sent back to the prompt. It shows your previous reason and asks
  whether it was fulfilled. Continuing requires a fresh reason and duration.
- **Anti-circumvention.**
  - A **30-second cooldown** after a session ends before you can start another on
    that host (shown as a live countdown; the form is disabled).
  - **Escalating friction:** each additional session on the same host within a
    rolling 2-hour window adds **+30s** to the cooldown and requires a **longer
    reason** (minimum characters × the session count in the window). A reason must
    always be ≥ 3 distinct words, so `aaaaaaaaaa` never works.
- **Local logging & review.** An options page lets you edit the gated list, see
  per-host stats for today (sessions, minutes, cancel rate), and browse the last
  200 sessions.

## Install (load unpacked)

The extension is the repository root (the folder containing `manifest.json`).
The `docs/` and `test/` folders are ignored by the browser.

### Brave

1. Open **`brave://extensions`**.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder
   (`.../chrome-extensions/gatekeeper`).
4. Pin the Gatekeeper icon if you like — the badge shows session time remaining.

> **Brave Shields:** Gatekeeper works alongside Shields. Its blocking uses the
> extension `declarativeNetRequest` API, which Shields does not interfere with
> (verified end-to-end against Brave — see Testing). No Shields changes needed.

### Chrome / Chromium / Edge

1. Open **`chrome://extensions`** (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this folder.

## Usage

1. Click the extension's **Options** (via `brave://extensions` → Details →
   Extension options, or right-click the icon → Options) to set your gated sites.
   `news.ycombinator.com` and `youtube.com` are seeded by default.
2. Navigate to a gated site. Fill in **why** (≥ 10 characters, ≥ 3 distinct words)
   and **how long** (a quick button or a number, capped at 30 minutes).
3. **Continue** (or `Ctrl`/`Cmd`+`Enter`) drops you at the exact URL you wanted.
   **Never mind** (or `Esc`) closes the tab.
4. When the timer expires, all tabs on that host return to the prompt.

## How it works

| Concern | Mechanism |
| --- | --- |
| Block full page loads before they paint | `declarativeNetRequest` dynamic redirect rule per gated host with no active session (`requestDomains` → subdomains match free) |
| Catch SPA navigation (e.g. YouTube's `pushState`) | `webNavigation.onHistoryStateUpdated` / `onReferenceFragmentUpdated` + a `tabs.onUpdated` fallback |
| Restore the exact original URL on Continue | `webNavigation.onBeforeNavigate` captures the intended URL per tab; the prompt fetches it from the service worker |
| Expiry that survives service-worker suspension | `chrome.alarms` is the source of truth; on every wake the worker reconciles stored deadlines against `Date.now()` and expires anything stale |
| Countdown badge | Best-effort refresh while the worker is awake; never gates expiry correctness |
| State | `chrome.storage.local` (config, sessions, cooldowns, friction window, logs); per-tab targets in `chrome.storage.session` |

See `docs/specs/2026-07-05-gatekeeper-design.md` for the full design.

## Testing

Verification runs against a **real Brave binary** via `puppeteer-core` (no
Chromium download). A local HTTP server backs a fake `gated.test` host through
`--host-resolver-rules`, so tests never hit the network.

```bash
cd test
npm install          # installs puppeteer-core only
npm test             # unit checks + full browser e2e (~90s; waits on a real 1-min alarm)

npm run test:unit    # fast: friction math, validation, badge formatting
npm run test:e2e     # browser: interception, SPA dodge, expiry reprompt, cooldown
```

Override the browser with `BRAVE_PATH=/path/to/browser npm run test:e2e`.

The e2e suite reproduces the acceptance path directly: start a 1-minute session →
badge counts down → open a second tab → at expiry **all** host tabs redirect to
the prompt → an instant restart is blocked by the cooldown. It also proves a
`history.pushState` navigation on a blocked host cannot dodge the gate.

## Privacy

Everything is local. No network requests, no analytics, no sync. The only host
permission is used to observe and gate navigation on your own machine; the
extension never transmits anything.

## License

[MIT](LICENSE) © Leo Schmidt-Traub
