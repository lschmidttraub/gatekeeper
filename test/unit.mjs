// Fast unit checks for the pure logic in lib/common.js — the pieces the browser
// e2e can't cheaply exercise (escalating friction, validation edge cases, badge).
// Run: node unit.mjs

import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  hostMatches,
  matchGatedHost,
  normalizeHostInput,
  validateReason,
  requiredReasonChars,
  cooldownSeconds,
  nextK,
  sessionCountInWindow,
  windowMs,
  clampMinutes,
  formatBadge,
  formatCountdown,
  distinctWordCount,
  pageKey,
  isExcluded,
} from '../lib/common.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e && e.message) || e}`);
  }
}

const cfg = DEFAULT_CONFIG;

test('subdomains match automatically', () => {
  assert.ok(hostMatches('youtube.com', 'youtube.com'));
  assert.ok(hostMatches('youtube.com', 'm.youtube.com'));
  assert.ok(hostMatches('youtube.com', 'music.youtube.com'));
  assert.ok(!hostMatches('youtube.com', 'notyoutube.com'));
  assert.ok(!hostMatches('youtube.com', 'youtube.com.evil.com'));
});

test('matchGatedHost returns the gated host or null', () => {
  assert.equal(matchGatedHost('www.youtube.com', ['youtube.com']), 'youtube.com');
  assert.equal(matchGatedHost('example.com', ['youtube.com']), null);
});

test('normalizeHostInput strips scheme/path/port', () => {
  assert.equal(normalizeHostInput('https://YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(normalizeHostInput('news.ycombinator.com'), 'news.ycombinator.com');
  assert.equal(normalizeHostInput('  m.youtube.com:443  '), 'm.youtube.com');
});

test('placeholder-mashing is rejected (needs >= 3 distinct words)', () => {
  assert.equal(distinctWordCount('aaaaaaaaaa'), 1);
  assert.equal(validateReason('aaaaaaaaaa', 1, cfg).ok, false);
  assert.equal(validateReason('word word word word', 1, cfg).ok, false); // 1 distinct word
});

test('a genuine reason passes at k=1', () => {
  assert.equal(validateReason('reading the tech news', 1, cfg).ok, true);
});

test('required reason length scales with k (min chars x k)', () => {
  assert.equal(requiredReasonChars(1, cfg), 10);
  assert.equal(requiredReasonChars(2, cfg), 20);
  assert.equal(requiredReasonChars(3, cfg), 30);
  // 13-char reason ok at k=1, rejected at k=2 (needs 20).
  assert.equal(validateReason('read the news', 1, cfg).ok, true);
  assert.equal(validateReason('read the news', 2, cfg).ok, false);
  assert.equal(validateReason('read the morning technology news today', 2, cfg).ok, true);
});

test('cooldown escalates by base x k', () => {
  assert.equal(cooldownSeconds(1, cfg), 30);
  assert.equal(cooldownSeconds(2, cfg), 60);
  assert.equal(cooldownSeconds(3, cfg), 90);
});

test('nextK counts sessions inside the rolling window', () => {
  const now = 1_000_000_000_000;
  const w = windowMs(cfg); // 2h
  const starts = [now - w - 1000, now - 60_000, now - 30_000]; // one is outside the window
  assert.equal(sessionCountInWindow(starts, now, w), 2);
  assert.equal(nextK(starts, now, cfg), 3);
});

test('clampMinutes enforces 1..hardCap', () => {
  assert.equal(clampMinutes(5, cfg), 5);
  assert.equal(clampMinutes(0, cfg), null);
  assert.equal(clampMinutes(-3, cfg), null);
  assert.equal(clampMinutes(999, cfg), cfg.hardCapMinutes);
  assert.equal(clampMinutes('abc', cfg), null);
});

test('badge format: minutes >= 1min, m:ss under 1min', () => {
  assert.equal(formatBadge(90_000), '1');
  assert.equal(formatBadge(60_000), '1');
  assert.equal(formatBadge(59_000), '0:59');
  assert.equal(formatBadge(5_000), '0:05');
  assert.equal(formatBadge(0), '');
  assert.equal(formatBadge(-100), '');
});

test('countdown format is m:ss', () => {
  assert.equal(formatCountdown(30_000), '0:30');
  assert.equal(formatCountdown(90_000), '1:30');
  assert.equal(formatCountdown(-5), '0:00');
});

test('pageKey strips query/fragment and lowercases host', () => {
  assert.equal(pageKey('https://X.com/u/status/123?s=20'), 'https://x.com/u/status/123');
  assert.equal(pageKey('https://x.com/u/status/123#frag'), 'https://x.com/u/status/123');
  assert.equal(pageKey('https://x.com/'), 'https://x.com/');
  assert.equal(pageKey('chrome://extensions'), null);
  assert.equal(pageKey('not a url'), null);
});

test('isExcluded matches a page regardless of query, and only that page', () => {
  const ex = [{ host: 'x.com', page: 'https://x.com/u/status/123', addedAt: 1 }];
  assert.equal(isExcluded('https://x.com/u/status/123', ex), true);
  assert.equal(isExcluded('https://x.com/u/status/123?s=20', ex), true);
  assert.equal(isExcluded('https://x.com/u/status/123#x', ex), true);
  // The boundary the DNR '^' anchor also protects: a longer sibling path is NOT excluded.
  assert.equal(isExcluded('https://x.com/u/status/1234', ex), false);
  assert.equal(isExcluded('https://x.com/u/status/12', ex), false);
  assert.equal(isExcluded('https://x.com/other', ex), false);
  // A subdomain page is its own page key — parent-host exclusion doesn't leak to it.
  assert.equal(isExcluded('https://m.x.com/u/status/123', ex), false);
});

test('isExcluded is safe on empty/invalid input', () => {
  assert.equal(isExcluded('https://x.com/a', []), false);
  assert.equal(isExcluded('https://x.com/a', undefined), false);
  assert.equal(isExcluded('not a url', [{ host: 'x.com', page: 'x' }]), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
