import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT_DIR = join(ROOT, 'tmp', 'ui-parity');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(child) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 12000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before UI check could start (${child.exitCode}).`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Server did not start at ${BASE_URL}: ${lastError?.message || 'timeout'}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  try {
    await waitForServer(child);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#homeView');
    await page.waitForSelector('#exampleManuscriptList .example-card', { timeout: 5000 });
    const heading = await page.locator('#heroHeadline').innerText();
    assert.match(heading, /Is your paper\s+ready to submit\?/i);
    await assertVisible(page, '.landing-brand-mark');
    await assertVisible(page, '.empty-hero-shot');
    await assertVisible(page, '#storedReviewsSection');
    await assertVisible(page, '#integrationsSection');
    const imageWidth = await page.locator('.empty-hero-shot').evaluate((img) => img.naturalWidth);
    assert.ok(imageWidth > 100, 'homepage screenshot asset should load');
    await page.screenshot({ path: join(OUT_DIR, 'homepage.png'), fullPage: true });

    await page.evaluate(() => {
      document.getElementById('homeView')?.classList.add('d-none');
      document.getElementById('reader')?.classList.remove('d-none');
    });
    await page.waitForSelector('#checks-tab');
    await page.waitForSelector('#chat-tab');
    await page.waitForSelector('#comment-tab');
    await page.waitForFunction(() => {
      const text = document.getElementById('essentialGuideList')?.textContent || '';
      return text.includes('Abstract page') && text.includes('IMRaD') && text.includes('Declarations');
    });
    const sideText = await page.locator('.studio-counts-pane').innerText();
    assert.match(sideText, /Essential guidelines/);
    assert.match(sideText, /Matched guidelines/);
    assert.match(sideText, /Open Science guidelines/);
    assert.match(sideText, /Custom guidelines/);
    await page.click('#essentialGuidelinesHeading button');
    await page.waitForSelector('#essentialGuideList .guide-card', { state: 'visible' });
    await page.waitForFunction(() => document.getElementById('essentialGuidelinesPanel')?.classList.contains('show'));
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(OUT_DIR, 'reader-checks-pane.png'), fullPage: true });

    await page.click('#chat-tab');
    await assertVisible(page, '#chatInput');
    await page.fill('#chatInput', 'What are the counts?');
    await page.click('#chatSendButton');
    await page.waitForFunction(() => (document.getElementById('chatMessageList')?.textContent || '').includes('No manuscript is open'));

    await page.click('#comment-tab');
    await assertVisible(page, '#commentInput');
    await page.fill('#commentInput', 'UI parity smoke comment');
    await page.click('#commentAddButton');
    await page.waitForFunction(() => (document.getElementById('commentList')?.textContent || '').includes('UI parity smoke comment'));
    await page.screenshot({ path: join(OUT_DIR, 'reader-side-panel.png'), fullPage: true });

    await browser.close();
  } finally {
    child.kill('SIGTERM');
    await delay(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (stderr.join('').trim()) {
    console.warn(stderr.join('').trim());
  }
}

async function assertVisible(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await locator.isVisible(), true, `${selector} should be visible`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
