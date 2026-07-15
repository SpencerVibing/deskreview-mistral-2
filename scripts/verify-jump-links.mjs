import { basename } from 'node:path';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8891';
const PDF_PATHS = process.argv.slice(2);
const COUNT_KINDS = ['authors', 'affiliations', 'abstract', 'article', 'keywords', 'references', 'tables', 'figures'];
const LONG_TIMEOUT = Number(process.env.JUMP_LINK_TIMEOUT_MS || 240000);

if (!PDF_PATHS.length) {
  console.error('Usage: node scripts/verify-jump-links.mjs <pdf> [pdf...]');
  process.exit(2);
}

function normalize(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function numberFromText(value = '') {
  const match = String(value || '').match(/\b\d[\d,]*\b/);
  return match ? Number(match[0].replace(/,/g, '')) : null;
}

async function waitForCountTiles(page) {
  await page.waitForFunction(
    (kinds) => {
      const failureText = () => String(document.querySelector('#htmlDocument .alert-danger')?.innerText || '').trim();
      if (failureText()) return true;
      return kinds.every((kind) => document.querySelector(`[data-count-kind="${kind}"]`));
    },
    COUNT_KINDS,
    { timeout: LONG_TIMEOUT }
  );
  const firstFailure = await page.evaluate(() => String(document.querySelector('#htmlDocument .alert-danger')?.innerText || '').trim());
  if (firstFailure) throw new Error(`OCR failed before count tiles rendered: ${firstFailure}`);
  await page.waitForFunction(
    (kinds) => {
      const failureText = () => String(document.querySelector('#htmlDocument .alert-danger')?.innerText || '').trim();
      if (failureText()) return true;
      return kinds.every((kind) => {
        const tile = document.querySelector(`[data-count-kind="${kind}"]`);
        if (!tile) return false;
        return !tile.classList.contains('is-busy') && !tile.hasAttribute('aria-busy');
      });
    },
    COUNT_KINDS,
    { timeout: LONG_TIMEOUT }
  );
  const secondFailure = await page.evaluate(() => String(document.querySelector('#htmlDocument .alert-danger')?.innerText || '').trim());
  if (secondFailure) throw new Error(`OCR failed before count tiles resolved: ${secondFailure}`);
}

async function captureVerifierSnapshot(page) {
  return page.evaluate(() => ({
    pages: document.querySelectorAll('.ocr-page').length,
    blocks: document.querySelectorAll('.ocr-block').length,
    htmlError: document.querySelector('#htmlDocument .alert-danger')?.innerText?.trim() || '',
    htmlText: document.querySelector('#htmlDocument')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 240) || '',
    tiles: [...document.querySelectorAll('[data-count-kind]')].map((tile) => ({
      kind: tile.getAttribute('data-count-kind') || '',
      text: tile.innerText?.replace(/\s+/g, ' ').trim() || '',
      busy: tile.classList.contains('is-busy') || tile.hasAttribute('aria-busy')
    }))
  })).catch(() => null);
}

async function clickCountTile(page, kind) {
  await page.evaluate((tileKind) => {
    const tile = document.querySelector(`[data-count-kind="${tileKind}"]`);
    tile?.scrollIntoView({ block: 'center', inline: 'nearest' });
    tile?.click();
  }, kind);
  await page.waitForFunction(
    () => {
      const body = document.querySelector('#detailsPanelBody');
      if (!body) return false;
      const text = body.innerText || '';
      return text.trim().length > 0 && !/Resolving|Preparing|Loading/i.test(text);
    },
    null,
    { timeout: LONG_TIMEOUT }
  );
}

async function validateDetailLinks(page, kind) {
  const links = await page.evaluate(() => [...document.querySelectorAll('#detailsPanelBody [data-detail-block-key]')]
    .map((node, index) => ({
      index,
      key: node.getAttribute('data-detail-block-key') || '',
      quote: node.getAttribute('data-detail-quote') || '',
      text: node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) || ''
    })));
  const failures = [];

  for (const link of links) {
    const precheck = await page.evaluate(({ key }) => ({
      targetExists: Boolean(document.getElementById(key)),
      targetType: document.getElementById(key)?.getAttribute('data-block-type') || ''
    }), link);
    if (!precheck.targetExists) {
      failures.push({ kind, type: 'missing-html-target', ...link });
      continue;
    }

    await page.evaluate(({ index }) => {
      const node = [...document.querySelectorAll('#detailsPanelBody [data-detail-block-key]')][index];
      node?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, link);

    const result = await page.waitForFunction(
      ({ key }) => {
        const active = document.querySelector('.ocr-block.active');
        const region = document.querySelector('.pdf-active-region');
        if (active?.id !== key || !region) return false;
        const rect = region?.getBoundingClientRect();
        return {
          activeId: active?.id || '',
          regionExists: Boolean(region),
          fallback: Boolean(region?.classList.contains('pdf-active-region-fallback')),
          width: rect?.width || 0,
          height: rect?.height || 0
        };
      },
      { key: link.key },
      { timeout: 15000 }
    ).then((handle) => handle.jsonValue()).catch((error) => ({
      error: String(error?.message || error || 'Timed out waiting for active jump target.')
    }));

    if (result.error) failures.push({ kind, type: 'jump-timeout', ...link, error: result.error });
    if (result.activeId !== link.key) failures.push({ kind, type: 'wrong-active-html-block', ...link, activeId: result.activeId });
    if (!result.regionExists) failures.push({ kind, type: 'missing-pdf-highlight', ...link });
    if (result.fallback) failures.push({ kind, type: 'fallback-pdf-highlight', ...link });
    if (result.regionExists && (result.width < 3 || result.height < 3)) failures.push({ kind, type: 'tiny-pdf-highlight', ...link, width: result.width, height: result.height });
  }

  return { links: links.length, failures };
}

async function validateReferenceDetails(page) {
  const details = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#detailsPanelBody .detail-card')].slice(1);
    const referenceStartCount = (text = '') => {
      const normalized = String(text || '').replace(/\s+/g, ' ').trim();
      const yearStarts = [...normalized.matchAll(/(?:^|(?<!\b[A-Z])\.\s*)(?=[A-Z][A-Za-z'.-]+,\s+(?:[A-Z]\.|[A-Z][A-Za-z'.-]+,).{0,180}?\(\d{4}[a-z]?\))/g)].length;
      const numberedStarts = [...normalized.matchAll(/(?:^|(?<!\b[A-Z])\.\s*)(?=(?:\[\s*\d{1,3}\s*\]|\d{1,3}\s*[.)])\s+[A-Z])/g)].length;
      return Math.max(yearStarts, numberedStarts);
    };
    const isReferenceLikeBlock = (node) => {
      const type = node.getAttribute('data-block-type') || '';
      const text = node.textContent || '';
      return type === 'references' || (type === 'list' && (referenceStartCount(text) > 1 || /^(?:\[\s*\d{1,3}\s*\]|\d{1,3}\s*[.)])\s+[A-Z]/.test(text.trim())));
    };
    const referenceBlockIds = new Set([...document.querySelectorAll('.ocr-block')].filter(isReferenceLikeBlock).map((node) => node.id));
    const entries = cards.map((card) => {
      const title = card.querySelector('.detail-card-title span')?.textContent?.trim() || '';
      const anchor = card.querySelector('.detail-text[data-detail-block-key]');
      const refText = anchor?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const uses = [...card.querySelectorAll('.border-top.py-2')].map((node) => ({
        label: node.querySelector('.small.fw-semibold')?.textContent?.trim() || '',
        text: node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300) || ''
      }));
      return {
        title,
        blockKey: anchor?.getAttribute('data-detail-block-key') || '',
        targetType: document.getElementById(anchor?.getAttribute('data-detail-block-key') || '')?.getAttribute('data-block-type') || '',
        refText,
        uses
      };
    });
    const malformedBlocks = [...document.querySelectorAll('.ocr-block')].filter(isReferenceLikeBlock)
      .map((block) => {
        const text = block.textContent?.replace(/\s+/g, ' ').trim() || '';
        const starts = referenceStartCount(text);
        return {
          id: block.id,
          paragraphCount: block.querySelectorAll('p').length,
          starts,
          text: text.slice(0, 240)
        };
      })
      .filter((block) => block.starts > 1 && block.paragraphCount < block.starts);
    return {
      referenceBlocks: [...referenceBlockIds],
      entries,
      malformedBlocks
    };
  });

  const failures = [];
  const seen = new Map();
  for (const entry of details.entries) {
    const signature = normalize(entry.refText).slice(0, 180);
    if (signature && seen.has(signature)) {
      failures.push({ type: 'duplicate-reference-card', first: seen.get(signature), duplicate: entry.title, refText: entry.refText.slice(0, 180) });
    } else if (signature) {
      seen.set(signature, entry.title);
    }
    if (details.referenceBlocks.length && entry.blockKey && !details.referenceBlocks.includes(entry.blockKey)) {
      failures.push({ type: 'reference-anchor-not-reference-block', title: entry.title, blockKey: entry.blockKey, targetType: entry.targetType, refText: entry.refText.slice(0, 180) });
    }
  }

  const numberedReferenceStyle = details.entries.slice(0, 8).filter((entry, index) => {
    const number = index + 1;
    return new RegExp(`^(?:\\[\\s*${number}\\s*\\]|${number}\\s*[.)])\\s+`).test(entry.refText);
  }).length >= 2;

  if (!numberedReferenceStyle) {
    for (const entry of details.entries) {
      for (const use of entry.uses) {
        if (/^(?:\^|\^\{|\([0-9]+\)|[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+|\$\^)/.test(use.label)) {
          failures.push({ type: 'numeric-use-in-author-year-references', title: entry.title, label: use.label, text: use.text });
        }
      }
    }
  }

  for (const block of details.malformedBlocks) {
    failures.push({ type: 'malformed-reference-html-block', ...block });
  }

  return {
    entries: details.entries.length,
    referenceBlocks: details.referenceBlocks.length,
    failures
  };
}

async function validatePdf(pdfPath) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await context.newPage();
  const name = basename(pdfPath);
  const result = {
    pdf: name,
    counts: {},
    detailLinks: {},
    failures: []
  };

  page.on('pageerror', (error) => {
    result.failures.push({ type: 'page-error', message: error.message });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#homePdfInput', pdfPath);
    await waitForCountTiles(page);

    result.counts = await page.evaluate((kinds) => Object.fromEntries(kinds.map((kind) => {
      const tile = document.querySelector(`[data-count-kind="${kind}"]`);
      return [kind, {
        text: tile?.innerText || '',
        value: Number((tile?.innerText || '').match(/\b\d[\d,]*\b/)?.[0]?.replace(/,/g, '') || 0)
      }];
    })), COUNT_KINDS);

    for (const kind of COUNT_KINDS) {
      await clickCountTile(page, kind);
      if (kind === 'references') {
        const referenceCheck = await validateReferenceDetails(page);
        result.detailLinks.referencesMeta = referenceCheck;
        result.failures.push(...referenceCheck.failures.map((failure) => ({ kind, ...failure })));
      }
      const detailCheck = await validateDetailLinks(page, kind);
      result.detailLinks[kind] = { links: detailCheck.links };
      result.failures.push(...detailCheck.failures);
    }
  } catch (error) {
    result.failures.push({
      type: 'pdf-run-failed',
      message: String(error?.message || error),
      snapshot: await captureVerifierSnapshot(page)
    });
  } finally {
    await context.close();
  }

  return result;
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const pdfPath of PDF_PATHS) {
    const result = await validatePdf(pdfPath);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await browser.close();
}

const failures = results.flatMap((result) => result.failures.map((failure) => ({ pdf: result.pdf, ...failure })));
if (failures.length) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exit(1);
}
