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
  while (Date.now() - started < 15000) {
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
    env: {
      ...process.env,
      PORT: String(PORT),
      DESKREVIEW_ENV_FILE: '/dev/null',
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || 'ui-parity-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const browserErrors = [];
  let browser = null;
  try {
    await waitForServer(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#homeView');
    await page.waitForSelector('#exampleManuscriptList .example-card', { timeout: 10000 });
    const heading = await page.locator('#heroHeadline').innerText();
    assert.match(heading, /Is your paper\s+ready to submit\?/i);
    await assertVisible(page, '.landing-brand-mark');
    await assertVisible(page, '.empty-hero-shot');
    await assertVisible(page, '#storedReviewsSection');
    await assertVisible(page, '#integrationsSection');
    const homeText = await page.locator('#homeView').innerText();
    assert.doesNotMatch(homeText, /Mistral OCR\s*\/\s*ChatGPT|ChatGPT/i, 'Home page should not expose a ChatGPT/Mistral provider toggle.');
    const imageWidth = await page.locator('.empty-hero-shot').evaluate((img) => img.naturalWidth);
    assert.ok(imageWidth > 100, 'homepage screenshot asset should load');
    await page.screenshot({ path: join(OUT_DIR, 'homepage.png'), fullPage: true });

    const medrxivCard = page.locator('[data-example-id="medrxiv-baseline"]');
    await medrxivCard.waitFor({ state: 'visible', timeout: 10000 });
    await assertText(page, '[data-example-id="medrxiv-baseline"]', /medRxiv \(2021 preprint\)/i);
    await assertText(page, '[data-example-id="medrxiv-baseline"]', /CONSORT/i);
    await medrxivCard.click();

    await page.waitForSelector('#reader:not(.d-none)', { timeout: 45000 });
    await page.waitForFunction(() => {
      const html = document.getElementById('htmlDocument')?.textContent || '';
      return html.includes('Combined Exercise Training') && document.querySelectorAll('.ocr-block').length >= 8;
    }, null, { timeout: 45000 });
    await assertText(page, '#tocList', /Title/i);
    await assertText(page, '#tocList', /Abstract/i);
    await assertCountTile(page, 'authors', /Authors\s+22/i);
    await assertCountTile(page, 'affiliations', /Affiliations\s+11/i);
    await assertCountTile(page, 'abstract', /Abstract\s+404/i);
    await assertCountTile(page, 'article', /Article\s+2[,.]403/i);
    await assertCountTile(page, 'references', /Refs\s+22/i);
    await assertCountTile(page, 'tables', /Tables\s+3/i);
    await assertCountTile(page, 'figures', /Figures\s+1/i);
    await assertReaderUiRegressionFixes(page);
    await assertChecksSectionCards(page);
    await assertGuidelineSelectorModal(page);
    await page.waitForSelector('#pdfDocument canvas', { timeout: 45000 });
    await page.waitForFunction(() => {
      return document.querySelectorAll('#htmlDocument [data-pdf-page-preview] canvas').length >= 4;
    }, null, { timeout: 20000 });
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-reader-checks.png'), fullPage: true });
    await page.click('#htmlTab');
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-html-manuscript.png'), fullPage: true });
    await page.click('#pdfTab');

    await openAccordion(page, '#essentialGuidelinesHeading button', '#essentialGuidelinesPanel');
    await assertText(page, '#essentialGuideList', /Abstract page/i);
    await assertText(page, '#essentialGuideList', /IMRaD structure/i);
    await assertText(page, '#essentialGuideList', /Declarations/i);
    await assertGuideAggregateCard(page, {
      rootSelector: '#essentialGuideList [data-guide-aggregate-lane="essential"]',
      status: 'skipped',
      titlePattern: /All Essential guideline items/i
    });
    await assertCompactGuidelineCards(page, '#essentialGuideList [data-essential-guide-id]');
    const essentialListText = await page.locator('#essentialGuideList').innerText();
    assert.doesNotMatch(essentialListText, /Guidelines developed by the European Association of Science Editors/i);
    assert.doesNotMatch(essentialListText, /EASE Essential guidelines/i);
    await page.click('#essentialGuideList [data-essential-guide-id="ease-abstract-page"] .guide-progress-mini');
    await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
    await assertText(page, '#detailsPanel', /Optional/i);
    await assertText(page, '#detailsPanel', /N\/A/i);
    await page.click('#detailsPanel [data-guide-detail-filter="optional"]');
    await waitForVisibleGuideResult(page, 'optional');
    await page.click('#detailsPanel [data-guide-detail-filter="all"]');
    await assertActiveJumpFromDetails(page);
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-essential-detail.png'), fullPage: true });
    await page.click('#detailsPanelClose');

    await openAccordion(page, '#matchedGuidelinesHeading button', '#matchedGuidelinesPanel');
    await assertText(page, '#reportingGuideList', /CONSORT/i);
    await assertText(page, '#reportingGuideList', /CERT/i);
    await assertText(page, '#reportingGuideList', /SAMPL/i);
    await assertText(page, '#reportingGuideList', /TIDieR/i);
    await assertText(page, '#reportingGuideList', /ICMJE Recommendations/i);
    await assertGuideAggregateCard(page, {
      rootSelector: '#reportingGuideList [data-guide-aggregate-lane="matched"]',
      status: 'absent',
      titlePattern: /All matched guideline items/i
    });
    await assertCompactGuidelineCards(page, '#reportingGuideList [data-reporting-guide-id]');
    const reportingListText = await page.locator('#reportingGuideList').innerText();
    assert.doesNotMatch(reportingListText, /randomized trials/i);
    assert.doesNotMatch(reportingListText, /Matched guideline/i);
    await assertGuidelineTitleOpensSelector(page, 'cert', /CERT/i);
    await page.click('#reportingGuideList [data-reporting-guide-id="consort"] .guide-progress-mini');
    await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
    await assertText(page, '#detailsPanel', /CONSORT/i);
    await assertText(page, '#detailsPanel', /Optional/i);
    await page.click('#detailsPanel [data-guide-detail-filter="warning"]');
    await waitForVisibleGuideResult(page, 'warning');
    await page.click('#detailsPanel [data-guide-detail-filter="all"]');
    await assertActiveJumpFromDetails(page);
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-reporting-detail.png'), fullPage: true });
    await page.click('#detailsPanelClose');

    await page.click('#feedbackReportButton');
    await page.waitForSelector('#feedbackReportModal.show', { timeout: 10000 });
    await assertText(page, '#feedbackReportModal', /Essential guidelines/i);
    await assertText(page, '#feedbackReportModal', /Matched reporting guidelines/i);
    await assertText(page, '#feedbackReportModal', /CONSORT/i);
    await assertText(page, '#feedbackReportModal', /ICMJE Recommendations/i);
    await assertActiveJumpFromFeedbackReport(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#feedbackReportModal.show', { state: 'detached', timeout: 10000 }).catch(async () => {
      await page.locator('#feedbackReportModal .btn-close').click();
      await page.waitForSelector('#feedbackReportModal.show', { state: 'detached', timeout: 10000 });
    });

    await page.click('#chat-tab');
    await assertVisible(page, '#chatInput');
    await page.fill('#chatInput', 'What are the counts?');
    await page.click('#chatSendButton');
    await assertText(page, '#chatMessageList', /References:\s+22/i);
    await assertText(page, '#chatMessageList', /Tables:\s+3/i);
    await assertText(page, '#chatMessageList', /Figures:\s+1/i);

    await page.click('#comment-tab');
    await assertVisible(page, '#commentInput');
    await page.fill('#commentInput', 'UI parity smoke comment');
    await page.click('#commentAddButton');
    await assertText(page, '#commentList', /UI parity smoke comment/i);
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-chat-comments.png'), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 420 });
    await assertScrollableContainer(page, '#tocList', { requireOverflow: true });
    await page.click('#checks-tab');
    await assertActiveSidePaneIsFlex(page);
    await assertScrollableContainer(page, '.counts-panel-scroll', { requireOverflow: true });
    await page.click('#chat-tab');
    await assertActiveSidePaneIsFlex(page);
    await assertScrollableContainer(page, '#chat-pane .overflow-auto');
    await page.click('#comment-tab');
    await assertActiveSidePaneIsFlex(page);
    await assertScrollableContainer(page, '#comment-pane .overflow-auto');

    assert.deepEqual(browserErrors, [], `Browser errors were emitted:\n${browserErrors.join('\n')}`);
  } finally {
    if (browser) await browser.close();
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
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await locator.isVisible(), true, `${selector} should be visible`);
}

async function assertText(page, selector, pattern) {
  await page.waitForFunction(({ selector: innerSelector, source, flags }) => {
    const text = document.querySelector(innerSelector)?.innerText || '';
    return new RegExp(source, flags).test(text);
  }, { selector, source: pattern.source, flags: pattern.flags }, { timeout: 15000 });
  const text = await page.locator(selector).first().innerText();
  assert.match(text, pattern);
}

async function assertCountTile(page, kind, pattern) {
  await assertText(page, `[data-count-kind="${kind}"]`, pattern);
}

async function assertChecksSectionCards(page) {
  await page.waitForSelector('#checksContentSections', { timeout: 10000 });
  assert.equal(await page.locator('#checksContentAccordion').count(), 0, 'Checks content should not use a top-level accordion.');
  const directItems = await page.locator('#checksContentSections > .side-group-card').count();
  assert.equal(directItems, 2, 'Checks content should have exactly two top-level section cards.');
  await assertText(page, '#articleCountsHeading', /Article element counts/i);
  await assertText(page, '#reportingQualityHeading', /Reporting quality guidelines/i);
  await assertVisible(page, '#articleCountsPanel');
  await assertVisible(page, '#reportingQualityPanel');
  const paneBackgrounds = await page.evaluate(() => {
    const countsPane = document.querySelector('.studio-counts-pane');
    const tocPane = document.querySelector('.studio-toc-pane');
    const articleCard = document.querySelector('#articleCountsPluginPanel');
    return {
      countsPane: getComputedStyle(countsPane).backgroundColor,
      tocPane: getComputedStyle(tocPane).backgroundColor,
      articleCard: getComputedStyle(articleCard).backgroundColor
    };
  });
  assert.equal(paneBackgrounds.countsPane, paneBackgrounds.tocPane, 'Right side pane should match the ToC background.');
  assert.match(paneBackgrounds.articleCard, /rgb\(255, 255, 255\)/, 'Checks section cards should be white.');
  const firstTileHeight = await page.locator('[data-count-kind="authors"]').evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(firstTileHeight <= 62, `Count tiles should be compact; first tile was ${firstTileHeight}px tall.`);
}

async function assertReaderUiRegressionFixes(page) {
  assert.equal(await page.locator('#openGuidelineCatalogButton').count(), 0, 'Guideline catalog kebab button should be removed.');
  assert.equal(await page.locator('#essentialGuidelineSummary').count(), 0, 'Essential guideline summary clutter should be removed.');
  assert.equal(await page.locator('#matchedGuidelineSummary').count(), 0, 'Matched guideline summary clutter should be removed.');
  const guideBarClasses = await page.locator('.guide-progress-mini .progress-bar').evaluateAll((nodes) => nodes.map((node) => node.className));
  assert.ok(guideBarClasses.length > 0, 'Guideline mini progress bars should render.');
  assert.ok(
    guideBarClasses.every((className) => /bg-\w+-subtle/.test(className)),
    `Guideline mini progress bars should use subtle colors: ${guideBarClasses.join(', ')}`
  );
  const firstHeading = await page.locator('#htmlDocument .ocr-block h1').first().innerText();
  assert.match(firstHeading, /Combined Exercise Training vs Health Education for Older Adults with Hypertension/i);
  assert.doesNotMatch(firstHeading, /Title page/i);
  const firstHeadingSize = await page.locator('#htmlDocument .ocr-block h1').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  const paragraphSize = await page.locator('#htmlDocument .ocr-block p').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  assert.ok(firstHeadingSize <= paragraphSize * 1.55, `HTML manuscript heading is too large: ${firstHeadingSize}px vs ${paragraphSize}px.`);
  assert.equal(await page.locator('#htmlDocument [data-block-type="table"]').count(), 3, 'HTML manuscript should render three table blocks.');
  assert.equal(await page.locator('#htmlDocument [data-block-type="figure"]').count(), 1, 'HTML manuscript should render one figure block.');
  assert.ok(await page.locator('#htmlDocument [data-pdf-page-preview]').count() >= 4, 'Display-item source page previews should render.');
}

async function assertGuidelineSelectorModal(page) {
  await page.click('#customizeChecksButton');
  await page.waitForSelector('#customizeChecksModal.show', { timeout: 10000 });
  await page.waitForSelector('#guidelineCardContainer .guideline-select-card', { timeout: 15000 });
  await assertText(page, '#guidelineFacetColumn', /All guides/i);
  await assertText(page, '#guidelineFacetColumn', /Scientific Domain/i);
  await page.fill('#guidelineSearchInput', 'CONSORT');
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('#guidelineCardContainer .guideline-select-card')]
      .some((node) => /CONSORT/i.test(node.innerText || ''));
  }, null, { timeout: 10000 });
  await page.click('#guidelineCardContainer [data-guideline-id="consort"] .card-title');
  await page.waitForSelector('#guidelineDetailSlider.active', { timeout: 10000 });
  await assertText(page, '#guidelineDetailName', /CONSORT/i);
  await assertText(page, '#guidelineDetailDescription', /random/i);
  await assertText(page, '#checklist-pane', /Title and abstract/i);
  await assertText(page, '#checklist-pane', /Randomisation|Randomization|Eligibility/i);
  await page.click('#checklist-pane [data-bs-toggle="collapse"]');
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('#checklist-pane .collapse.show')]
      .some((node) => (node.innerText || '').trim().length > 0);
  }, null, { timeout: 10000 });
  await page.click('#scope-tab');
  await assertText(page, '#scope-pane', /Aim/i);
  await assertText(page, '#scope-pane', /Coverage/i);
  await page.click('#references-tab');
  await assertText(page, '#references-pane', /Official guideline/i);
  await assertText(page, '#references-pane', /BMJ|doi/i);
  const referenceHref = await page.locator('#references-pane a[href]').first().getAttribute('href');
  assert.match(referenceHref || '', /^https:\/\//);
  await page.click('#closeGuidelineDetailSliderBtn');
  await page.waitForSelector('#guidelineDetailSlider.active', { state: 'detached', timeout: 1000 }).catch(async () => {
    assert.equal(await page.locator('#guidelineDetailSlider').evaluate((node) => node.classList.contains('active')), false);
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#customizeChecksModal.show', { state: 'detached', timeout: 10000 }).catch(async () => {
    await page.locator('#customizeChecksModal .btn-close').click();
    await page.waitForSelector('#customizeChecksModal.show', { state: 'detached', timeout: 10000 });
  });
}

async function assertGuideAggregateCard(page, { rootSelector, status, titlePattern }) {
  await assertVisible(page, rootSelector);
  await assertText(page, rootSelector, /Combined results/i);
  assert.doesNotMatch(await page.locator(rootSelector).innerText(), titlePattern, 'Combined results card should not repeat the full aggregate title.');
  await assertText(page, rootSelector, /Present/i);
  await assertText(page, rootSelector, /Absent/i);
  await page.click(`${rootSelector} .dropdown-toggle`);
  await page.click(`${rootSelector} .dropdown-menu.show [data-guide-aggregate-status="${status}"]`);
  await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
  await assertText(page, '#detailsPanel', titlePattern);
  await waitForVisibleGuideResult(page, status);
  await page.click('#detailsPanelClose');
}

async function assertCompactGuidelineCards(page, cardSelector) {
  await page.locator(cardSelector).first().waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator(`${cardSelector} .guide-card-kicker`).count(), 0, 'Guideline cards should not show source/kicker headers.');
  assert.equal(await page.locator(`${cardSelector} .badge`).count(), 0, 'Guideline cards should not show status badge grids or status badges.');
  const firstHeight = await page.locator(cardSelector).first().evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(firstHeight <= 78, `Guideline cards should be compact; first card was ${firstHeight}px tall.`);
}

async function assertGuidelineTitleOpensSelector(page, guideId, titlePattern) {
  await page.click(`#reportingGuideList [data-guideline-selector-open="${guideId}"]`);
  await page.waitForSelector('#customizeChecksModal.show', { timeout: 10000 });
  await delay(300);
  assert.equal(
    await page.locator('#guidelineDetailSlider').evaluate((node) => node.classList.contains('active')),
    false,
    'Guideline detail slider should wait after the modal grid appears.'
  );
  await page.waitForSelector('#guidelineDetailSlider.active', { timeout: 10000 });
  await assertText(page, '#guidelineDetailName', titlePattern);
  await assertText(page, '#checklist-pane', /Checklist details|Title|Abstract|intervention|training/i);
  await page.click('#closeGuidelineDetailSliderBtn');
  await page.waitForSelector('#guidelineDetailSlider.active', { state: 'detached', timeout: 1000 }).catch(async () => {
    assert.equal(await page.locator('#guidelineDetailSlider').evaluate((node) => node.classList.contains('active')), false);
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#customizeChecksModal.show', { state: 'detached', timeout: 10000 }).catch(async () => {
    await page.locator('#customizeChecksModal .btn-close').click();
    await page.waitForSelector('#customizeChecksModal.show', { state: 'detached', timeout: 10000 });
  });
}

async function assertPanelState(page, selector, expectedOpen) {
  await page.waitForFunction(({ selector: innerSelector, expected }) => {
    const panel = document.querySelector(innerSelector);
    return panel
      && !panel.classList.contains('collapsing')
      && panel.classList.contains('show') === expected;
  }, { selector, expected: expectedOpen }, { timeout: 10000 });
}

async function openAccordion(page, buttonSelector, panelSelector) {
  const isOpen = await page.locator(panelSelector).evaluate((node) => node.classList.contains('show'));
  if (!isOpen) await page.click(buttonSelector);
  await page.locator(panelSelector).waitFor({ state: 'visible', timeout: 10000 });
}

async function waitForVisibleGuideResult(page, status) {
  await page.waitForFunction((selectedStatus) => {
    return [...document.querySelectorAll('#detailsPanel [data-guide-result-status]')]
      .some((node) => node.dataset.guideResultStatus === selectedStatus && !node.classList.contains('d-none'));
  }, status, { timeout: 10000 });
}

async function assertActiveJumpFromDetails(page) {
  const link = page.locator('#detailsPanel [data-detail-block-key]').first();
  await link.waitFor({ state: 'visible', timeout: 10000 });
  const blockKey = await link.getAttribute('data-detail-block-key');
  assert.ok(blockKey, 'Detail jump link should carry a block key.');
  await link.click();
  await assertBlockActive(page, blockKey);
}

async function assertActiveJumpFromFeedbackReport(page) {
  const link = page.locator('#feedbackReportBody [data-detail-block-key]').first();
  await link.waitFor({ state: 'visible', timeout: 10000 });
  const blockKey = await link.getAttribute('data-detail-block-key');
  assert.ok(blockKey, 'Feedback report jump link should carry a block key.');
  await link.click();
  await assertBlockActive(page, blockKey);
}

async function assertBlockActive(page, blockKey) {
  await page.waitForFunction((key) => {
    return document.querySelector(`[data-block-id="${key}"]`)?.classList.contains('active');
  }, blockKey, { timeout: 10000 });
}

async function assertActiveSidePaneIsFlex(page) {
  const display = await page.locator('.reader-side-shell .tab-pane.active').evaluate((node) => getComputedStyle(node).display);
  assert.equal(display, 'flex', 'Active side panel tab should use flex layout so inner content can scroll.');
}

async function assertScrollableContainer(page, selector, { requireOverflow = false } = {}) {
  const result = await page.locator(selector).first().evaluate((node) => {
    const before = node.scrollTop;
    node.scrollTop = 0;
    const style = getComputedStyle(node);
    const canOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';
    node.scrollTop = 120;
    const scrolled = node.scrollTop > 0;
    const metrics = {
      canOverflow,
      scrolled,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowY: style.overflowY
    };
    node.scrollTop = before;
    return metrics;
  });
  assert.ok(result.clientHeight > 0, `${selector} should have a bounded visible height.`);
  assert.ok(result.canOverflow, `${selector} should allow vertical scrolling, got overflow-y: ${result.overflowY}.`);
  if (requireOverflow) {
    assert.ok(
      result.scrollHeight > result.clientHeight,
      `${selector} should have content below the fold in the short viewport.`
    );
    assert.ok(result.scrolled, `${selector} should move when scrollTop is changed.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
