// Gatekeeper end-to-end verification.
//
// Loads the unpacked extension into a real Brave binary (puppeteer-core, no
// Chromium download) and drives the full expiry -> reprompt -> cooldown path,
// plus the SPA-dodge net. A local HTTP server backs a fake gated host
// (`gated.test`) via --host-resolver-rules so tests never touch the network.
//
// Run:  node e2e.mjs        (BRAVE_PATH overrides the browser binary)

import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const BRAVE = process.env.BRAVE_PATH || '/opt/brave.com/brave/brave-browser';
const GATED = 'gated.test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e && e.message) || e}`);
  }
}

async function waitForUrl(page, predicate, timeout = 15000, label = '') {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    last = page.url();
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for url ${label}; last=${last}`);
}

function badgeToSeconds(b) {
  if (/^\d+$/.test(b)) return parseInt(b, 10) * 60;
  const m = b.match(/^(\d+):(\d\d)$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
}

async function main() {
  // --- local server backing gated.test --------------------------------------
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><meta charset=utf-8><title>Gated Content</title>` +
        `<body style="font-family:sans-serif;padding:2rem">` +
        `<h1 id=gated-content>Gated content served</h1><p>path: ${req.url}</p>`
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`\nLocal server for ${GATED} on 127.0.0.1:${port}`);
  console.log(`Browser: ${BRAVE}`);

  const browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP ${GATED} 127.0.0.1:${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Re-enable --load-extension (recent Chromium disables it by default) and
      // silence Translate popups.
      '--disable-features=Translate,DisableLoadExtensionCommandLineSwitch',
    ],
  });

  let exitCode = 1;
  try {
    // --- grab the extension service worker ----------------------------------
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'),
      { timeout: 20000 }
    );
    const worker = await swTarget.worker();
    const extId = new URL(swTarget.url()).host;
    const promptPrefix = `chrome-extension://${extId}/prompt/prompt.html`;
    console.log(`Extension id: ${extId}\n`);

    const hooksReady = await worker.evaluate(() => typeof self.gatekeeper === 'object');
    assert.ok(hooksReady, 'service worker test hooks not present');

    const reset = async () => {
      await worker.evaluate(async (h) => {
        await self.gatekeeper._resetAll();
        await self.gatekeeper._setConfig({ gatedHosts: [h] });
      }, GATED);
    };

    // ======================================================================
    // Scenario A — SPA dodge net (fast)
    // ======================================================================
    console.log('Scenario A: SPA navigation on a blocked host cannot dodge the gate');
    await reset();
    await worker.evaluate((h) => self.gatekeeper.startSession(h, 'browsing the site now', 5), GATED);
    const spa = await browser.newPage();
    await spa.goto(`http://${GATED}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});

    await step('gated content loads while a session is active', async () => {
      assert.ok(spa.url().startsWith(`http://${GATED}/`), `expected gated content, got ${spa.url()}`);
    });

    // Re-block the host but leave the tab sitting on gated content.
    await worker.evaluate((h) => self.gatekeeper._blockHostQuiet(h), GATED);

    await step('history.pushState on a blocked host is redirected to the prompt', async () => {
      await spa.evaluate(() => history.pushState({}, '', '/watch?v=dodge'));
      await waitForUrl(spa, (u) => u.startsWith(promptPrefix), 8000, '(spa->prompt)');
    });
    await spa.close();

    // ======================================================================
    // Scenario B — full timed flow (the acceptance script)
    // ======================================================================
    console.log('\nScenario B: fresh gate -> 1-minute session -> expiry reprompt -> cooldown');
    await reset();

    const page = await browser.newPage();
    await page.goto(`http://${GATED}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});

    await step('fresh navigation to a gated host is intercepted before load', async () => {
      await waitForUrl(page, (u) => u.startsWith(promptPrefix), 15000, '(nav->prompt)');
      await page.waitForSelector('#reason', { visible: true, timeout: 10000 });
      const shownHost = await page.$eval('#host', (el) => el.textContent);
      assert.equal(shownHost, GATED, 'prompt should display the gated host');
    });

    await step('Continue starts a session and restores the exact original URL', async () => {
      await page.type('#reason', 'reading the tech news');
      await page.click('#minutes', { clickCount: 3 });
      await page.type('#minutes', '1');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        page.click('#continue'),
      ]);
      await waitForUrl(page, (u) => u.startsWith(`http://${GATED}/`), 15000, '(prompt->content)');
      const session = await worker.evaluate(async (h) => {
        const a = await self.gatekeeper.readAll();
        return a.sessions[h] || null;
      }, GATED);
      assert.ok(session && session.expiresAt > Date.now(), 'session should be active after Continue');
    });

    await step('badge counts down while the session is active', async () => {
      await page.bringToFront();
      const b1 = await worker.evaluate(async () => {
        await self.gatekeeper.updateBadgeForActiveTab();
        return self.gatekeeper._getBadgeText();
      });
      assert.match(b1, /^(\d+|0:\d\d)$/, `unexpected badge "${b1}"`);
      await sleep(3500);
      const b2 = await worker.evaluate(async () => {
        await self.gatekeeper.updateBadgeForActiveTab();
        return self.gatekeeper._getBadgeText();
      });
      assert.match(b2, /^(\d+|0:\d\d)$/, `unexpected badge "${b2}"`);
      assert.ok(
        badgeToSeconds(b2) < badgeToSeconds(b1),
        `badge should decrease: ${b1} -> ${b2}`
      );
    });

    const page2 = await browser.newPage();
    await step('a new tab on the same host passes through during an active session', async () => {
      await page2.goto(`http://${GATED}/watch`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(600);
      assert.ok(
        page2.url().startsWith(`http://${GATED}/`),
        `second tab should pass through, got ${page2.url()}`
      );
    });

    await step('at expiry, every open tab on the host is redirected to the prompt', async () => {
      console.log('    … waiting up to 100s for the 1-minute alarm to fire');
      await Promise.all([
        waitForUrl(page, (u) => u.startsWith(promptPrefix), 100000, '(tab1 expiry)'),
        waitForUrl(page2, (u) => u.startsWith(promptPrefix), 100000, '(tab2 expiry)'),
      ]);
    });

    await step('the expired session is logged with an outcome', async () => {
      const logs = await worker.evaluate(async () => (await self.gatekeeper.readAll()).logs);
      const last = logs[logs.length - 1];
      assert.ok(last && last.host === GATED, 'expected a log entry for the host');
      assert.ok(
        ['completed', 'abandoned_early'].includes(last.outcome),
        `unexpected outcome ${last && last.outcome}`
      );
    });

    await step('an instant restart is blocked by the cooldown', async () => {
      const st = await worker.evaluate((h) => self.gatekeeper.getPromptState(h), GATED);
      assert.ok(st.cooldownUntil > Date.now(), 'cooldown should be active right after expiry');
      const restart = await worker.evaluate(
        (h) => self.gatekeeper.startSession(h, 'trying again right now', 5),
        GATED
      );
      assert.equal(restart.ok, false, 'restart during cooldown should be rejected');
      assert.match(restart.error || '', /cooldown/i, `unexpected error: ${restart.error}`);
    });

    await step('the reprompt UI disables Continue during cooldown', async () => {
      // page is on the freshly-loaded reprompt; give it a beat to render.
      await page.waitForSelector('#continue', { timeout: 8000 });
      await sleep(400);
      const disabled = await page.$eval('#continue', (el) => el.disabled);
      assert.ok(disabled, 'Continue should be disabled while cooling down');
    });
    await page.close();
    await page2.close();

    // ======================================================================
    // Scenario C — per-page exclusions
    // ======================================================================
    console.log('\nScenario C: allow-list a specific page; it survives the gate and expiry');
    await reset();
    const ARTICLE = `http://${GATED}/research/article-1`;

    const research = await browser.newPage();
    await research.goto(ARTICLE, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForUrl(research, (u) => u.startsWith(promptPrefix), 15000, '(research->prompt)');

    await step('the prompt offers to always-allow the exact page', async () => {
      await research.waitForSelector('#allowPage', { visible: true, timeout: 10000 });
      const preview = await research.$eval('#allowPreview', (el) => el.textContent);
      assert.equal(preview, ARTICLE, `preview should show the page key, got ${preview}`);
    });

    await step('"Always allow this page" loads the page and records the exclusion', async () => {
      await Promise.all([
        research.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        research.click('#allowPage'),
      ]);
      await waitForUrl(research, (u) => u.startsWith(ARTICLE), 15000, '(prompt->allowed page)');
      const ex = await worker.evaluate(async () => (await self.gatekeeper.readAll()).exclusions);
      assert.ok(ex.some((e) => e.page === ARTICLE), 'exclusion should be stored');
    });

    await step('a fresh tab to the excluded page (with query) loads directly — DNR allow beats redirect', async () => {
      const again = await browser.newPage();
      await again.goto(`${ARTICLE}?src=twitter`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(700);
      assert.ok(again.url().startsWith(ARTICLE), `excluded page should load, got ${again.url()}`);
      await again.close();
    });

    await step('a longer sibling path on the same host is still gated (^ anchor boundary)', async () => {
      const sibling = await browser.newPage();
      await sibling.goto(`${ARTICLE}2`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForUrl(sibling, (u) => u.startsWith(promptPrefix), 15000, '(sibling->prompt)');
      await sibling.close();
    });

    await step('at expiry, the excluded tab stays put while a non-excluded tab is reprompted', async () => {
      const feed = await browser.newPage();
      await worker.evaluate((h) => self.gatekeeper.startSession(h, 'checking the feed now', 1), GATED);
      await feed.goto(`http://${GATED}/feed`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      assert.ok(feed.url().startsWith(`http://${GATED}/feed`), 'feed tab should load during the session');

      // Expire via the hook (the real-alarm path is already proven in Scenario B).
      await worker.evaluate((h) => self.gatekeeper.handleExpiry(h), GATED);

      await waitForUrl(feed, (u) => u.startsWith(promptPrefix), 10000, '(feed expiry reprompt)');
      await sleep(800); // give any erroneous redirect a chance to fire on the excluded tab
      assert.ok(
        research.url().startsWith(ARTICLE),
        `excluded tab must NOT be redirected at expiry, but url is ${research.url()}`
      );
      await feed.close();
    });
    await research.close();

    exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('\nFATAL:', e && e.stack ? e.stack : e);
    exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}

main();
