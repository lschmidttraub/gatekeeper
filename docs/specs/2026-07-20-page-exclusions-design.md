# Gatekeeper — Per-Page Exclusions

**Date:** 2026-07-20
**Status:** Approved, building
**Builds on:** [2026-07-05 Gatekeeper design](./2026-07-05-gatekeeper-design.md)

Let a specific page on a gated host be permanently allow-listed from the prompt,
so a research tab (e.g. an x.com article) stays open and is never gated or pulled
back at expiry — while the rest of the host still prompts as before.

## Goals & non-goals

- **Goal:** From the prompt, one tap ("Always allow this page") permanently
  excludes *this specific page*. Excluded pages never gate and never get
  redirected at session expiry.
- **Goal:** Exclusions are narrow (per-page) and visible/removable in Options, so
  they can't become a broad hole in the gate.
- **Non-goal (YAGNI):** No path-prefix or wildcard exclusions from the prompt, no
  whole-host exclusions, no time-boxed/expiring exclusions.

## Design decisions (approved)

- **Match scope:** *exact page, ignoring query and fragment.* A page is
  identified by `origin + pathname` (the "page key"). `x.com/u/status/123`,
  `…/123?s=20`, and `…/123#x` are the same page; `…/1234` is not.
- **Friction:** one-tap allow — no reason or timer required. The action is logged
  (`outcome: 'excluded'`) and listed in Options.

## Bypass mechanism

Reuse the existing DNR machinery. Block rules already redirect a gated host at
priority 1. Each exclusion adds a higher-priority **`allow`** rule for its page;
`allow` outranks `redirect`, so the page passes at the network layer with no
content flash. (Code-only gating was rejected — it redirects post-commit and
flashes; a single negative-lookahead regex rule was rejected — DNR's RE2 has no
lookahead.)

## Data model

New top-level `chrome.storage.local` key, separate from `config` so gated-list and
exclusion edits don't collide:

```
exclusions: [ { host, page, addedAt } ]
```

- `host` — the gated host the page belongs to (matched with existing `hostMatches`).
- `page` — the page key (`origin + pathname`), lowercased host, path case preserved,
  no trailing-slash normalization beyond what the URL parser yields.

## lib/common.js (pure, unit-tested)

- `pageKey(url)` → `origin + pathname`, or `null` for non-http(s)/unparseable URLs.
- `isExcluded(url, exclusions)` → true iff some entry has `hostMatches(entry.host,
  host(url))` **and** `entry.page === pageKey(url)`.

## Service worker

- `rebuildDnrRules()` — after the per-host block rules, append one `allow` rule per
  exclusion whose host is currently gated. Priority 2 (above the priority-1 block).
  `condition.urlFilter = '|' + page + '^'` (`|` anchors URL start; `^` matches a
  separator or end-of-URL, so query variants match but `…/1234` does not),
  `resourceTypes: ['main_frame']`. Rule IDs allocated in a range above the block
  rules to avoid collisions.
- Add an early `isExcluded(url, exclusions)` guard (return / skip) in:
  `maybeRedirectSpa`, the `tabs.onUpdated` fallback redirect, `enforceOpenTabs`,
  and the expiry reprompt loop in `handleExpiry` (so excluded tabs stay put at
  expiry). `onBeforeNavigate` target capture also skips excluded URLs.
- New message `excludePage {host, url}`: compute page key, add `{host, page,
  addedAt: Date.now()}` if absent, `rebuildDnrRules()`, append a log entry
  `{outcome: 'excluded', reason: '', requestedMinutes: null}`, respond `{ok}`.
- Test hook: expose nothing new beyond `readAll()` (already returns storage);
  add `exclusions` to `readAll()`'s returned object.

## Prompt page

- A third action button **"Always allow this page"**, placed between "Never mind"
  and "Continue", with a one-line preview of the exact page key that will be
  allowed. Visible only when there is a valid gated target.
- Click → send `excludePage {host, url: target}` → on `ok`, `location.replace(target)`.
- Disabled during cooldown alongside the other actions? No — excluding is not a
  new session, so it stays enabled during cooldown. (Cooldown only blocks starting
  a *timed session*.)

## Options page

- New "Always-allowed pages" section, grouped by host. Each entry shows the page
  key with a **Remove** button. Removing rewrites `exclusions`; the existing
  `storage.onChanged` listener rebuilds DNR and re-enforces open tabs live.
- Also re-render this section on `exclusions` changes.

## Logging & stats

- `excluded` becomes a fourth outcome. The log table shows an `excluded` tag; the
  outcome-tag CSS gains a style for it. In per-host "today" stats, `excluded` is
  counted on its own line (not a session, not a cancel — excluded from cancel-rate
  denominator).

## Testing

- **Unit** (`lib/common.js`): `pageKey` strips query/fragment and lowercases host;
  `isExcluded` matches subdomains via `hostMatches`, ignores query, and rejects the
  `…/123` vs `…/1234` boundary; non-http URLs return `null`/`false`.
- **E2E** (real Brave): navigate to a gated page → click "Always allow this page" →
  assert it loads. Then start and expire a 1-minute session on the same host and
  assert the **excluded tab is NOT redirected** while a **non-excluded tab on the
  same host IS** redirected to the prompt. This dual assertion is the core of the
  feature.
