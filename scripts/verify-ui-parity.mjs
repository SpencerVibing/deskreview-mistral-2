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
    await assertOriginalPreprintExampleCards(page);
    await page.screenshot({ path: join(OUT_DIR, 'homepage.png'), fullPage: true });

    const medrxivCard = page.locator('[data-example-id="medrxiv-baseline"]');
    await medrxivCard.waitFor({ state: 'visible', timeout: 10000 });
    await assertText(page, '[data-example-id="medrxiv-baseline"]', /medRxiv\s+·\s+2021\s+·\s+preprint/i);
    await assertText(page, '[data-example-id="medrxiv-baseline"]', /Combined Exercise Training vs Health Education/i);
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
    await assertAuthorDetailListNoNumbering(page);
    await assertCountTileBootstrapTooltips(page);
    await assertReaderUiRegressionFixes(page);
    await assertChecksSectionCards(page);
    await assertGuidelineSelectorModal(page);
    await page.waitForSelector('#pdfDocument canvas', { timeout: 45000 });
    await page.waitForFunction(() => {
      return document.querySelectorAll('#htmlDocument [data-pdf-page-preview] canvas').length >= 4;
    }, null, { timeout: 20000 });
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-reader-checks.png'), fullPage: true });
    await switchReaderView(page, 'html');
    await page.screenshot({ path: join(OUT_DIR, 'medrxiv-html-manuscript.png'), fullPage: true });
    await switchReaderView(page, 'pdf');

    await openAccordion(page, '#essentialGuidelinesHeading button', '#essentialGuidelinesPanel');
    await assertText(page, '#essentialGuideList', /Abstract page/i);
    await assertText(page, '#essentialGuideList', /IMRaD structure/i);
    await assertText(page, '#essentialGuideList', /Declarations/i);
    await assertGuideAggregateCard(page, {
      rootSelector: '#essentialGuideList [data-guide-aggregate-lane="essential"]',
      status: 'skipped',
      titlePattern: /All Essential guideline items/i,
      unframed: true
    });
    await assertCompactGuidelineCards(page, '#essentialGuideList [data-essential-guide-id]');
    await assertGuideListRows(page, {
      listSelector: '#essentialGuideList',
      cardSelector: '[data-essential-guide-id]',
      expectedCount: 3,
      label: 'Essential guideline'
    });
    const essentialListText = await page.locator('#essentialGuideList').innerText();
    assert.doesNotMatch(essentialListText, /Guidelines developed by the European Association of Science Editors/i);
    assert.doesNotMatch(essentialListText, /EASE Essential guidelines/i);
    await page.click('#essentialGuideList [data-essential-guide-id="ease-abstract-page"] .guide-progress-mini');
    await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
    await assertGuideDetailFilterDropdown(page);
    await assertGuideDetailFilterOption(page, 'optional', /Optional/i);
    await assertGuideDetailFilterOption(page, 'na', /N\s*\/\s*A/i);
    await selectGuideDetailFilter(page, 'optional');
    await waitForVisibleGuideResult(page, 'optional');
    await selectGuideDetailFilter(page, 'all');
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
      titlePattern: /All matched guideline items/i,
      unframed: true
    });
    await assertCompactGuidelineCards(page, '#reportingGuideList [data-reporting-guide-id]');
    await assertGuideListRows(page, {
      listSelector: '#reportingGuideList',
      cardSelector: '[data-reporting-guide-id]',
      expectedCount: 5,
      label: 'Matched guideline'
    });
    const reportingListText = await page.locator('#reportingGuideList').innerText();
    assert.doesNotMatch(reportingListText, /randomized trials/i);
    assert.doesNotMatch(reportingListText, /Matched guideline/i);
    await assertGuidelineTitleOpensSelector(page, 'cert', /CERT/i);
    await page.click('#reportingGuideList [data-reporting-guide-id="consort"] .guide-progress-mini');
    await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
    await assertText(page, '#detailsPanel', /CONSORT/i);
    await assertGuideDetailFilterDropdown(page);
    await assertGuideDetailFilterOption(page, 'optional', /Optional/i);
    await selectGuideDetailFilter(page, 'warning');
    await waitForVisibleGuideResult(page, 'warning');
    await selectGuideDetailFilter(page, 'all');
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

async function switchReaderView(page, view) {
  const showHtml = view === 'html';
  const control = page.locator('#viewModeSwitch');
  await control.waitFor({ state: 'visible', timeout: 10000 });
  if (await control.isChecked() !== showHtml) await control.setChecked(showHtml);
  await page.waitForFunction((expectedView) => {
    const activeId = expectedView === 'html' ? 'htmlView' : 'pdfView';
    const inactiveId = expectedView === 'html' ? 'pdfView' : 'htmlView';
    return document.getElementById(activeId)?.classList.contains('active')
      && !document.getElementById(inactiveId)?.classList.contains('active');
  }, view, { timeout: 10000 });
}

async function assertOriginalPreprintExampleCards(page) {
  const expected = [
    ['medrxiv-baseline', /medRxiv\s+·\s+2021\s+·\s+preprint/i, /Combined Exercise Training vs Health Education/i],
    ['chemRxivPDF', /chemRxiv\s+·\s+2025\s+·\s+preprint/i, /soy protein substitute/i],
    ['EarthArXiv', /EarthArXiv\s+·\s+2021\s+·\s+preprint/i, /Modeling Lithospheric Radioactivity/i],
    ['ResearchSquarePDF', /Research Square\s+·\s+2023\s+·\s+preprint/i, /Teleround System for Intensive Care Units/i],
    ['psyArXiv', /psyArXiv\s+·\s+preprint/i, /dangerous driving behavior/i]
  ];
  await page.waitForFunction(() => document.querySelectorAll('#exampleManuscriptList .example-card').length === 5, null, { timeout: 10000 });
  assert.equal(await page.locator('#exampleManuscriptList .example-card').count(), 5, 'Homepage should show the five original preprint examples.');
  const allCardText = await page.locator('#exampleManuscriptList').innerText();
  assert.doesNotMatch(allCardText, /Humpback whale|Guideline annotation/i, 'Homepage examples should not show non-preprint local/demo cards.');
  for (const [id, metaPattern, titlePattern] of expected) {
    const selector = `[data-example-id="${id}"]`;
    await assertText(page, selector, metaPattern);
    await assertText(page, selector, titlePattern);
    assert.equal(await page.locator(`${selector} .card-body .text-secondary.small`).count(), 1, `${id} should have the original metadata line.`);
    assert.equal(await page.locator(`${selector} .card-footer .example-stars`).count(), 1, `${id} should have the original stars footer.`);
    assert.equal(await page.locator(`${selector} .card-footer .example-items`).count(), 1, `${id} should have the original item-count footer.`);
    assert.equal(await page.locator(`${selector} .badge`).count(), 0, `${id} should not show tag/status badges.`);
  }
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('#exampleManuscriptList .example-items')]
      .every((node) => /\d[\d,]*\s+items/.test(node.textContent || ''));
  }, null, { timeout: 15000 });
}

async function assertCountTile(page, kind, pattern) {
  await assertText(page, `[data-count-kind="${kind}"]`, pattern);
}

async function assertAuthorDetailListNoNumbering(page) {
  await page.click('[data-count-kind="authors"]');
  await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
  await assertText(page, '#detailsPanelBody', /Authors/i);
  await assertText(page, '#detailsPanel', /Lucas Porto Santos/i);
  const detailText = await page.locator('#detailsPanel').innerText();
  assert.doesNotMatch(detailText, /\bAuthor\s+\d+\b/i, 'Authors detail list should not show ordinal labels.');
  await page.click('#detailsPanelClose');
  await page.waitForFunction(() => !document.getElementById('detailsPanel')?.classList.contains('open'), null, { timeout: 10000 });
}

async function assertCountTileBootstrapTooltips(page) {
  const countTiles = page.locator('[data-count-kind]');
  const tileCount = await countTiles.count();
  assert.ok(tileCount >= 7, 'Count tiles should render before checking tooltips.');
  assert.equal(await page.locator('[data-count-kind][title]').count(), 0, 'Count tiles should not use native title tooltips.');
  assert.equal(await page.locator('.count-result-bar[title]').count(), 0, 'Count result bars should not use native title tooltips.');
  assert.equal(
    await page.locator('[data-count-kind][data-bs-toggle="tooltip"][data-bs-custom-class="count-tile-tooltip"]').count(),
    tileCount,
    'Every count tile should use a Bootstrap tooltip.'
  );
  await page.locator('[data-count-kind="article"]').hover();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.tooltip.count-tile-tooltip.show').count(), 0, 'Count tile tooltip should wait before showing.');
  await page.waitForSelector('.tooltip.count-tile-tooltip.show', { timeout: 10000 });
  const tooltipText = await page.locator('.tooltip.count-tile-tooltip.show').innerText();
  assert.match(tooltipText, /Article:\s+2[,.]403 words/i);
  assert.match(tooltipText, /Click to view source-linked details/i);
  await page.mouse.move(5, 5);
  await page.waitForSelector('.tooltip.count-tile-tooltip.show', { state: 'detached', timeout: 10000 });
}

async function assertChecksSectionCards(page) {
  await page.waitForSelector('#checksContentSections', { timeout: 10000 });
  assert.equal(await page.locator('#checksContentAccordion').count(), 0, 'Checks content should not use a top-level accordion.');
  const directItems = await page.locator('#checksContentSections > .side-group-card').count();
  assert.equal(directItems, 2, 'Checks content should have exactly two top-level section cards.');
  assert.equal(await page.locator('#checksContentSections > .side-group-card.card').count(), 2, 'Checks sections should use Bootstrap card containers.');
  assert.equal(await page.locator('#checksContentSections > .side-group-card > .card-header').count(), 2, 'Checks section labels should use Bootstrap card headers.');
  assert.ok(
    String(await page.locator('#articleCountsHeading').getAttribute('class') || '').split(/\s+/).includes('card-header'),
    'Article counts heading should be a Bootstrap card header.'
  );
  assert.ok(
    String(await page.locator('#reportingQualityHeading').getAttribute('class') || '').split(/\s+/).includes('card-header'),
    'Reporting quality heading should be a Bootstrap card header.'
  );
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
  await assertVisible(page, '#viewModeSwitch');
  assert.equal(await page.locator('#pdfTab').count(), 0, 'PDF view should use the Bootstrap switch instead of the old tab button.');
  assert.equal(await page.locator('#htmlTab').count(), 0, 'HTML view should use the Bootstrap switch instead of the old tab button.');
  assert.equal(await page.locator('#viewModeSwitch').getAttribute('role'), 'switch', 'Reader view control should be exposed as a switch.');
  assert.equal(await page.locator('#viewModeSwitch').isChecked(), false, 'Reader should default to the PDF side of the switch.');
  assert.match(await page.locator('#viewSwitchPdfLabel').getAttribute('class'), /fw-semibold/, 'PDF label should be emphasized when PDF is active.');
  assert.match(await page.locator('#viewSwitchHtmlLabel').getAttribute('class'), /text-secondary/, 'HTML label should be muted when PDF is active.');
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

async function assertGuideAggregateCard(page, { rootSelector, status, titlePattern, unframed = false }) {
  await assertVisible(page, rootSelector);
  assert.equal(await page.locator(`${rootSelector} [data-guide-aggregate-kicker]`).count(), 0, 'Combined results label should be removed from aggregate cards.');
  assert.doesNotMatch(await page.locator(rootSelector).innerText(), /Combined results/i, 'Aggregate card should not show the Combined results label.');
  const rootClassTokens = String(await page.locator(rootSelector).getAttribute('class') || '').split(/\s+/);
  if (unframed) {
    ['card', 'border', 'shadow-sm', 'guide-card'].forEach((token) => {
      assert.ok(!rootClassTokens.includes(token), `Unframed Combined results should not include ${token}.`);
    });
  }
  assert.doesNotMatch(await page.locator(rootSelector).innerText(), titlePattern, 'Combined results card should not repeat the full aggregate title.');
  const cardText = await page.locator(rootSelector).innerText();
  assert.doesNotMatch(cardText, /\d+\s+present\s*·\s*\d+\s+absent/i, 'Combined card should not show the present/absent summary line.');
  assert.doesNotMatch(cardText, /\d+\/\d+\s+guides processed/i, 'Aggregate status line should not repeat processed guide progress.');
  const donutText = await page.locator(`${rootSelector} .guide-score-donut-label`).innerText();
  assert.match(donutText, /\d+\/\d+\s+guides/i, 'Combined card donut should show processed guide progress.');
  assert.doesNotMatch(donutText, /ready/i, 'Combined card donut should not show ready percentage copy.');
  assert.equal(await page.locator(`${rootSelector} [data-guide-aggregate-rating-stars] i.bi`).count(), 5, 'Combined card should show the old star rating row.');
  const ratingValue = await page.locator(`${rootSelector} [data-guide-aggregate-rating-value]`).innerText();
  assert.match(ratingValue, /\d(?:\.\d)?\s*\/\s*5/i, 'Combined card should include a rating value.');
  const processedText = await page.locator(`${rootSelector} [data-guide-aggregate-processed]`).innerText();
  assert.doesNotMatch(processedText, /\d+\/\d+\s+guides processed/i);
  assert.match(processedText, /\d+\s*\/\s*\d+\s+items checked/i, 'Combined card status line should show checked item progress.');
  const looseBadgeCount = await page.locator(`${rootSelector} > .card-body .badge`).evaluateAll((nodes) => {
    return nodes.filter((node) => !node.closest('.dropdown-menu')).length;
  });
  assert.equal(looseBadgeCount, 0, 'Combined card should not show loose status badge rows.');
  assert.equal(await page.locator(`${rootSelector} .guide-progress-mini`).count(), 0, 'Combined card should not show a mini bar chart.');
  assert.ok(
    String(await page.locator(`${rootSelector} .guide-overall-summary`).getAttribute('class') || '').split(/\s+/).includes('mb-3'),
    'Combined card should keep whitespace below the overall summary.'
  );
  await assertAggregateLayout(page, rootSelector);
  const defaultStatus = await page.locator(`${rootSelector} > .card-body .btn-group > [data-guide-aggregate-open]`).first().getAttribute('data-guide-aggregate-status');
  await expectAggregateButtonTone(page, rootSelector, defaultStatus || 'absent');
  await page.click(`${rootSelector} .dropdown-toggle`);
  await page.click(`${rootSelector} .dropdown-menu.show [data-guide-aggregate-status="${status}"]`);
  await expectAggregateButtonTone(page, rootSelector, status);
  await page.waitForSelector('#detailsPanel.open', { timeout: 10000 });
  await assertText(page, '#detailsPanel', titlePattern);
  await waitForVisibleGuideResult(page, status);
  await page.click('#detailsPanelClose');
}

async function assertAggregateLayout(page, rootSelector) {
  const donutBox = await page.locator(`${rootSelector} .guide-score-donut`).boundingBox();
  const ratingBox = await page.locator(`${rootSelector} [data-guide-aggregate-rating]`).boundingBox();
  const processedBox = await page.locator(`${rootSelector} [data-guide-aggregate-processed]`).boundingBox();
  const buttonBox = await page.locator(`${rootSelector} > .card-body .btn-group`).boundingBox();
  assert.ok(ratingBox && donutBox && ratingBox.x > donutBox.x, 'Combined card rating should sit in the right-hand details column.');
  assert.ok(
    donutBox && ratingBox && Math.abs(donutBox.y - ratingBox.y) <= 2,
    `Donut top should align with rating row top; donut y=${donutBox?.y}, rating y=${ratingBox?.y}.`
  );
  assert.ok(
    donutBox && buttonBox && Math.abs((donutBox.y + donutBox.height) - (buttonBox.y + buttonBox.height)) <= 3,
    `Donut bottom should align with dropdown bottom; donut bottom=${donutBox ? donutBox.y + donutBox.height : 'n/a'}, button bottom=${buttonBox ? buttonBox.y + buttonBox.height : 'n/a'}.`
  );
  assert.ok(ratingBox && processedBox && processedBox.y > ratingBox.y, 'Combined card status line should sit under the rating row.');
  assert.ok(processedBox && buttonBox && buttonBox.y > processedBox.y, 'Aggregate dropdown should sit under the processed guide text.');
  assert.ok(
    processedBox && buttonBox && Math.abs(buttonBox.x - processedBox.x) <= 1,
    'Aggregate dropdown should be left aligned with the processed guide text.'
  );
}

async function expectAggregateButtonTone(page, rootSelector, status) {
  const expected = {
    absent: ['bg-danger-subtle', 'text-danger-emphasis'],
    warning: ['bg-warning-subtle', 'text-warning-emphasis'],
    present: ['bg-success-subtle', 'text-success-emphasis'],
    optional: ['bg-info-subtle', 'text-info-emphasis'],
    skipped: ['bg-secondary-subtle', 'text-secondary-emphasis'],
    na: ['bg-secondary-subtle', 'text-secondary-emphasis']
  }[status] || ['bg-secondary-subtle', 'text-secondary-emphasis'];
  const className = await page.locator(`${rootSelector} > .card-body .btn-group > [data-guide-aggregate-status="${status}"]`).first().getAttribute('class');
  expected.forEach((token) => assert.ok(className?.includes(token), `Aggregate ${status} button should include ${token}; got ${className}`));
}

async function assertCompactGuidelineCards(page, cardSelector) {
  await page.locator(cardSelector).first().waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator(`${cardSelector} .guide-card-kicker`).count(), 0, 'Guideline cards should not show source/kicker headers.');
  assert.equal(await page.locator(`${cardSelector} .badge`).count(), 0, 'Guideline cards should not show status badge grids or status badges.');
  const firstHeight = await page.locator(cardSelector).first().evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(firstHeight <= 78, `Guideline cards should be compact; first card was ${firstHeight}px tall.`);
}

async function assertGuideListRows(page, { listSelector, cardSelector, expectedCount, label }) {
  const rowSelector = `${listSelector} ${cardSelector}`;
  const firstCard = page.locator(rowSelector).first();
  const firstClassTokens = String(await firstCard.getAttribute('class') || '').split(/\s+/);
  ['card', 'border', 'shadow-sm'].forEach((token) => {
    assert.ok(!firstClassTokens.includes(token), `${label} rows should not include ${token}.`);
  });
  const baseFrame = await firstCard.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      boxShadow: style.boxShadow
    };
  });
  assert.deepEqual(
    [baseFrame.borderTopWidth, baseFrame.borderRightWidth, baseFrame.borderBottomWidth, baseFrame.borderLeftWidth],
    ['0px', '0px', '0px', '0px'],
    `${label} rows should not render borders.`
  );
  assert.equal(baseFrame.boxShadow, 'none', `${label} rows should not render shadows.`);
  await firstCard.hover();
  const hoverFrame = await firstCard.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow
    };
  });
  assert.equal(hoverFrame.backgroundColor, 'rgb(244, 244, 245)', `${label} row hover should match the ToC light grey highlight.`);
  assert.equal(hoverFrame.boxShadow, 'none', `${label} row hover should not add a shadow.`);
  const rows = await page.locator(rowSelector).evaluateAll((nodes) => {
    return nodes.map((node) => {
      const card = node.getBoundingClientRect();
      const title = node.querySelector('[data-guideline-selector-open]')?.getBoundingClientRect();
      const progress = node.querySelector('.guide-progress-mini')?.getBoundingClientRect();
      return {
        card: { x: card.x, y: card.y, width: card.width, height: card.height },
        title: title ? { x: title.x, y: title.y, width: title.width, height: title.height } : null,
        progress: progress ? { x: progress.x, y: progress.y, width: progress.width, height: progress.height } : null
      };
    });
  });
  assert.equal(rows.length, expectedCount, `${label} list should show the expected guide rows.`);
  rows.forEach((row, index) => {
    assert.ok(row.title, `${label} ${index + 1} should include a title.`);
    assert.ok(row.progress, `${label} ${index + 1} should include a mini progress bar.`);
    assert.ok(row.progress.x > row.title.x, `${label} ${index + 1} progress bar should sit to the right of the title.`);
    assert.ok(
      Math.abs((row.title.y + row.title.height / 2) - (row.progress.y + row.progress.height / 2)) <= 6,
      `${label} ${index + 1} title and progress bar should share one row.`
    );
    if (index > 0) {
      const gap = row.card.y - (rows[index - 1].card.y + rows[index - 1].card.height);
      assert.ok(gap >= 0 && gap <= 6, `${label} rows should stack tightly; gap was ${gap}px.`);
    }
  });
  const widths = rows.map((row) => row.progress.width);
  const rightEdges = rows.map((row) => row.progress.x + row.progress.width);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `${label} progress bars should use a fixed width.`);
  assert.ok(Math.max(...rightEdges) - Math.min(...rightEdges) <= 1, `${label} progress bars should align right.`);
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

async function assertGuideDetailFilterDropdown(page) {
  await assertVisible(page, '#guideFilterControl:not(.d-none) .dropdown');
  await assertVisible(page, '#guideFilterControl .guide-filter-label');
  await assertVisible(page, '#detailsPanel .guide-slider-content .analyzed-guide-accordion');
  assert.equal(
    await page.locator('#detailsPanel .btn-group[aria-label="Filter guideline results"]').count(),
    0,
    'Guideline detail filters should use the dropdown widget instead of the old button group.'
  );
  assert.equal(await page.locator('#detailsPanel .guide-detail-filter-dropdown').count(), 0, 'Guideline detail filters should render in the header guideFilterControl.');
  assert.equal(await page.locator('#detailsPanel [data-guide-detail-filter-current]').count(), 0, 'Guideline detail filters should use the original guideFilterControl attributes.');
  assert.equal(await page.locator('#detailsPanel .guide-result-card').count(), 0, 'Guideline detail results should not use flat guide-result-card cards.');
  assert.ok(await page.locator('#detailsPanel .analyzed-item-row[data-result]').count() > 0, 'Guideline results should render analyzed accordion rows.');
  assert.ok(await page.locator('#detailsPanel .guide-section-badge').count() > 0, 'Guideline accordion sections should render count badges.');
  assert.ok(await page.locator('#detailsPanel .analyzed-item-copy-btn[data-copy-analyzed-item]').count() > 0, 'Guideline rows should include old-style copy feedback buttons.');
  assert.equal(await page.locator('#detailsPanel .analyzed-item-row .d-flex.align-items-start.justify-content-between > .badge').count(), 0, 'Guideline row headers should not show status badges.');
}

async function assertGuideDetailFilterOption(page, status, pattern) {
  const option = page.locator(`#guideFilterControl [data-guide-filter="${status}"]`).first();
  assert.equal(await option.count(), 1, `Guideline detail filter should include ${status}.`);
  const label = await option.locator('[data-guide-filter-label]').innerText();
  assert.match(label || '', pattern);
}

async function selectGuideDetailFilter(page, status) {
  const trigger = page.locator('#guideFilterControl button[data-bs-toggle="dropdown"]').first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const opened = await page.waitForFunction(() => {
    return document.querySelector('#guideFilterControl .dropdown-menu')?.classList.contains('show');
  }, null, { timeout: 1500 }).then(() => true).catch(() => false);
  if (!opened) {
    await trigger.evaluate((button) => window.bootstrap?.Dropdown?.getOrCreateInstance(button)?.show());
    await page.waitForFunction(() => {
      return document.querySelector('#guideFilterControl .dropdown-menu')?.classList.contains('show');
    }, null, { timeout: 10000 });
  }
  await page.click(`#guideFilterControl .dropdown-menu.show [data-guide-filter="${status}"]`);
  await page.waitForFunction(() => {
    return !document.querySelector('#guideFilterControl .dropdown-menu')?.classList.contains('show');
  }, null, { timeout: 10000 });
  await page.waitForFunction((selectedStatus) => {
    const button = document.querySelector('#guideFilterControl button[data-bs-toggle="dropdown"]');
    const label = button?.textContent || '';
    const selected = document.querySelector(`#guideFilterControl [data-guide-filter="${selectedStatus}"]`);
    const selectedLabel = selected?.querySelector('[data-guide-filter-label]')?.textContent?.trim().split(/\s+/)[0] || '';
    return selected?.classList.contains('active') && new RegExp(selectedStatus === 'all' ? 'All' : selectedLabel, 'i').test(label);
  }, status, { timeout: 10000 });
  await page.waitForTimeout(350);
}

async function waitForVisibleGuideResult(page, status) {
  await page.waitForFunction((selectedStatus) => {
    return [...document.querySelectorAll('#detailsPanel [data-guide-result-status]')]
      .some((node) => node.dataset.guideResultStatus === selectedStatus && !node.classList.contains('is-filtered-out'));
  }, status, { timeout: 10000 });
  const hiddenCount = await page.locator(`#detailsPanel [data-guide-result-status]:not([data-guide-result-status="${status}"]).is-filtered-out`).count();
  assert.ok(hiddenCount > 0, 'Non-matching guideline cards should animate out with is-filtered-out.');
  const visibleSectionCount = await page.locator('#detailsPanel [data-guide-section]:not(.is-filtered-out)').count();
  assert.ok(visibleSectionCount > 0, 'At least one accordion section should remain visible after filtering.');
  const badgeText = await page.locator('#detailsPanel [data-guide-section]:not(.is-filtered-out) .guide-section-badge').first().innerText();
  assert.match(badgeText, /\d+/, 'Visible accordion section badge should update to a numeric count.');
}

async function assertActiveJumpFromDetails(page) {
  if (!await page.locator('#detailsPanel [data-detail-block-key]:visible').count()) {
    const summaryToggle = page.locator('#detailsPanel .analyzed-item-row:not(.is-filtered-out):visible .analyzed-item-summary[data-bs-toggle="collapse"]').first();
    if (await summaryToggle.count()) await summaryToggle.click();
    const quoteToggle = page.locator('#detailsPanel .analyzed-item-row:not(.is-filtered-out):visible button[data-bs-toggle="collapse"]').filter({ hasText: /Show quotes/i }).first();
    if (await quoteToggle.count()) await quoteToggle.click();
  }
  const link = page.locator('#detailsPanel [data-detail-block-key]:visible').first();
  await link.waitFor({ state: 'visible', timeout: 10000 });
  const blockKey = await link.getAttribute('data-detail-block-key');
  assert.ok(blockKey, 'Detail jump link should carry a block key.');
  assert.ok(await link.getAttribute('data-detail-quote'), 'Detail jump link should carry quote text for PDF targeting.');
  await link.click();
  await assertBlockActive(page, blockKey);
  await assertPdfActiveRegion(page, { requireTextMatched: true });
  await switchReaderView(page, 'html');
  await assertHtmlActiveHighlight(page, blockKey);
  await switchReaderView(page, 'pdf');
}

async function assertActiveJumpFromFeedbackReport(page) {
  const link = page.locator('#feedbackReportBody [data-detail-block-key]').first();
  await link.waitFor({ state: 'visible', timeout: 10000 });
  const blockKey = await link.getAttribute('data-detail-block-key');
  assert.ok(blockKey, 'Feedback report jump link should carry a block key.');
  assert.ok(await link.getAttribute('data-detail-quote'), 'Feedback report jump link should carry quote text for PDF targeting.');
  await link.click();
  await assertBlockActive(page, blockKey);
  await assertPdfActiveRegion(page, { requireTextMatched: true });
}

async function assertBlockActive(page, blockKey) {
  await page.waitForFunction((key) => {
    return document.querySelector(`[data-block-id="${key}"]`)?.classList.contains('active');
  }, blockKey, { timeout: 10000 });
}

async function assertHtmlActiveHighlight(page, blockKey) {
  await page.waitForFunction((key) => {
    const node = document.querySelector(`[data-block-id="${key}"]`);
    if (!node?.classList.contains('active')) return false;
    const style = getComputedStyle(node);
    return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
  }, blockKey, { timeout: 10000 });
}

async function assertPdfActiveRegion(page, { requireTextMatched = false } = {}) {
  await page.waitForFunction(() => {
    const region = document.querySelector('.pdf-active-region');
    if (!region) return false;
    const box = region.getBoundingClientRect();
    const style = getComputedStyle(region);
    return box.width > 8
      && box.height > 8
      && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
      && style.display !== 'none';
  }, null, { timeout: 10000 });
  if (requireTextMatched) {
    await page.waitForFunction(() => {
      const region = document.querySelector('.pdf-active-region');
      return region && !region.classList.contains('pdf-active-region-fallback');
    }, null, { timeout: 10000 });
  }
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
