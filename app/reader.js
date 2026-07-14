import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs';
import { buildCountProgress, countBenchmarkForKind } from '/core/count-progress.js';
import {
  buildDocumentAnnotationRequest,
  normalizeDocumentAnnotation
} from '/core/document-annotation.js';
import { evaluateEssentialGuides } from '/core/essential-guidelines.js';
import { projectTocEntries } from '/core/toc.js';
import {
  deleteStoredReview,
  getStoredReview,
  listStoredReviews,
  putStoredReview
} from '/services/browser-library.js';
import { loadEssentialGuides } from '/services/guideline-data.js';
import {
  annotateDocument,
  requestOcr,
  resolveCounts,
  resolveDisplayItems,
  resolveReferences
} from '/services/mistral-client.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';

const state = {
  file: null,
  pdfUrl: '',
  pdfDoc: null,
  zoom: 1,
  pdfResizeTimer: 0,
  pages: [],
  pageViews: new Map(),
  blockTargets: new Map(),
  tocEntries: [],
  activeBlockKey: '',
  startedAt: 0,
  pdfRenderToken: 0,
  activeView: 'pdf',
  activeSplitter: '',
  tocOpen: true,
  semanticCounts: null,
  detailCache: new Map(),
  detailBuildStatus: new Map(),
  activeDetailKind: '',
  currentReviewId: '',
  library: [],
  currentReview: null,
  loadedFromLibrary: false,
  pendingDeleteReviewId: '',
  progressTimer: 0,
  checkReveal: {
    phase: 'idle',
    startedAt: 0,
    visibleKinds: [],
    resultKinds: [],
    lastResultAt: 0,
    resultTimer: 0,
    timers: []
  },
  tileReady: {},
  tilePulseUntil: {},
  runtime: {
    startedAt: 0,
    fileName: '',
    events: []
  },
  ocrProgress: {
    status: 'idle',
    startedAt: 0,
    estimateMs: 18000
  },
  referenceResolver: {
    status: 'idle',
    result: null,
    error: '',
    completed: 0,
    total: 0,
    startedAt: 0
  },
  countResolver: {
    status: 'idle',
    result: null,
    error: '',
    startedAt: 0
  },
  displayResolver: {
    status: 'idle',
    result: null,
    error: '',
    startedAt: 0
  },
  displayResolverPromise: null,
  documentAnnotation: {
    status: 'idle',
    result: null,
    error: '',
    startedAt: 0
  },
  documentAnnotationPromise: null,
  essentialGuides: [],
  essentialResults: [],
  essentialStatus: 'idle',
  pdfSearch: {
    query: '',
    matches: [],
    index: -1
  }
};

const COUNT_TILE_ORDER = [
  'authors',
  'affiliations',
  'abstract',
  'article',
  'keywords',
  'references',
  'tables',
  'figures'
];
const COUNT_TILE_ENTRANCE_MS = 1500;
const COUNT_RESULT_GAP_MS = 3000;

const els = {
  homeView: document.getElementById('homeView'),
  reader: document.getElementById('reader'),
  homeInput: document.getElementById('homePdfInput'),
  reviewLibraryBody: document.getElementById('reviewLibraryBody'),
  tocToggleButton: document.getElementById('tocToggleButton'),
  tocSplitter: document.getElementById('tocSplitter'),
  countsSplitter: document.getElementById('countsSplitter'),
  fileName: document.getElementById('fileName'),
  elapsedBadge: document.getElementById('elapsedBadge'),
  pagesBadge: document.getElementById('pagesBadge'),
  charsBadge: document.getElementById('charsBadge'),
  sizeBadge: document.getElementById('sizeBadge'),
  libraryBack: document.getElementById('libraryBack'),
  countsGrid: document.getElementById('countsGrid'),
  essentialGuideList: document.getElementById('essentialGuideList'),
  essentialGuidelineSummary: document.getElementById('essentialGuidelineSummary'),
  tocList: document.getElementById('tocList'),
  pdfScroll: document.getElementById('pdfScroll'),
  pdfDocument: document.getElementById('pdfDocument'),
  htmlScroll: document.getElementById('htmlScroll'),
  htmlDocument: document.getElementById('htmlDocument'),
  pdfTab: document.getElementById('pdfTab'),
  htmlTab: document.getElementById('htmlTab'),
  pdfView: document.getElementById('pdfView'),
  htmlView: document.getElementById('htmlView'),
  pdfSearchInput: document.getElementById('pdfSearchInput'),
  pdfSearchPrev: document.getElementById('pdfSearchPrev'),
  pdfSearchNext: document.getElementById('pdfSearchNext'),
  pdfSearchCount: document.getElementById('pdfSearchCount'),
  runtimeSummaryButton: document.getElementById('runtimeSummaryButton'),
  runtimeSummaryCopy: document.getElementById('runtimeSummaryCopy'),
  runtimeSummaryBody: document.getElementById('runtimeSummaryBody'),
  runtimeSummaryModal: document.getElementById('runtimeSummaryModal'),
  deleteReviewModal: document.getElementById('deleteReviewModal'),
  deleteReviewName: document.getElementById('deleteReviewName'),
  deleteReviewConfirm: document.getElementById('deleteReviewConfirm'),
  feedbackReportButton: document.getElementById('feedbackReportButton'),
  feedbackReportBody: document.getElementById('feedbackReportBody'),
  feedbackReportModal: document.getElementById('feedbackReportModal'),
  feedbackReportPdf: document.getElementById('feedbackReportPdf'),
  detailsPanel: document.getElementById('detailsPanel'),
  detailsPanelTitle: document.getElementById('detailsPanelTitle'),
  detailsPanelBody: document.getElementById('detailsPanelBody'),
  detailsPanelClose: document.getElementById('detailsPanelClose')
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeMistralHtml(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
}

function setStatus() {}

function setBadge(element, value = '') {
  if (!element) return;
  const text = String(value || '').trim();
  element.classList.toggle('d-none', !text);
  const label = element.querySelector('span');
  if (label) label.textContent = text;
}

function formatDuration(ms = 0) {
  const seconds = Number(ms || 0) / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatEta(ms = 0) {
  const seconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  if (seconds <= 0) return 'nearly there';
  if (seconds < 60) return `about ${seconds} sec left`;
  return `about ${Math.ceil(seconds / 60)} min left`;
}

function boundedProgress(elapsedMs = 0, estimateMs = 18000) {
  const elapsed = Math.max(0, Number(elapsedMs || 0));
  const estimate = Math.max(1000, Number(estimateMs || 18000));
  return Math.max(8, Math.min(92, Math.round((elapsed / estimate) * 100)));
}

function statusSpinner() {
  return '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>';
}

function runtimeNow() {
  return performance.now();
}

function resetRuntime(fileName = '') {
  state.runtime = {
    startedAt: runtimeNow(),
    fileName,
    events: []
  };
  markRuntime('Upload selected', { fileName });
}

function markRuntime(label = '', data = {}) {
  if (!state.runtime.startedAt) {
    state.runtime.startedAt = runtimeNow();
  }
  state.runtime.events.push({
    label,
    elapsedMs: Math.round(runtimeNow() - state.runtime.startedAt),
    ...data
  });
}

function runtimeSummaryText() {
  const events = state.runtime.events || [];
  const lines = [
    `Runtime summary`,
    `File: ${state.runtime.fileName || state.file?.name || 'none'}`,
    `Generated: ${new Date().toISOString()}`,
    ''
  ];
  if (!events.length) {
    lines.push('No runtime events recorded yet.');
    return lines.join('\n');
  }
  events.forEach((event) => {
    const { label, elapsedMs, ...data } = event;
    const details = Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'number' && /Ms$/.test(key) ? formatDuration(value) : value}`)
      .join(', ');
    lines.push(`${formatDuration(elapsedMs).padStart(7)}  ${label}${details ? `  (${details})` : ''}`);
  });
  return lines.join('\n');
}

function renderRuntimeSummary() {
  if (!els.runtimeSummaryBody) return;
  els.runtimeSummaryBody.textContent = runtimeSummaryText();
}

function reportDetail(kind = '') {
  return state.detailCache.get(kind)?.detail || state.detailCache.get(kind) || {};
}

function reportItems(kind = '') {
  const detail = reportDetail(kind);
  return Array.isArray(detail.items) ? detail.items : [];
}

function reportCountCard(label = '', value = null, unit = '', note = '') {
  return `
    <div class="col-6 col-lg-3">
      <div class="card h-100 border-0 shadow-sm">
        <div class="card-body p-3">
          <div class="small text-secondary mb-1">${escapeHtml(label)}</div>
          <div class="d-flex align-items-baseline gap-2">
            <div class="fs-5 fw-semibold">${escapeHtml(metricValue(value))}</div>
            ${unit ? `<div class="small text-secondary">${escapeHtml(unit)}</div>` : ''}
          </div>
          ${note ? `<div class="small text-secondary mt-2">${escapeHtml(note)}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function reportList(title = '', items = [], emptyText = 'No results were returned yet.') {
  return `
    <div class="card border-0 shadow-sm mb-3">
      <div class="card-body p-3">
        <div class="small fw-bold text-body mb-2">${escapeHtml(title)}</div>
        ${items.length ? `
          <div class="list-group list-group-flush">
            ${items.map((item, index) => `
              <div class="list-group-item px-0">
                <div class="small text-secondary mb-1">${escapeHtml(index + 1)}</div>
                <div>${escapeHtml(item.text || item.label || item.title || String(item || ''))}</div>
              </div>
            `).join('')}
          </div>
        ` : `<div class="text-secondary small">${escapeHtml(emptyText)}</div>`}
      </div>
    </div>
  `;
}

function reportWarnings(warnings = []) {
  const cleanWarnings = (Array.isArray(warnings) ? warnings : [warnings]).filter(Boolean);
  if (!cleanWarnings.length) return '';
  return `
    <div class="alert alert-warning small mb-3">
      ${cleanWarnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('')}
    </div>
  `;
}

function feedbackReportHtml() {
  const counts = getOcrCounts();
  const semantic = state.semanticCounts || {};
  const abstractDetail = reportDetail('abstract');
  const articleDetail = reportDetail('article');
  const referencesDetail = reportDetail('references');
  const referenceEntries = Array.isArray(referencesDetail.entries) ? referencesDetail.entries : [];
  const articleSections = Array.isArray(articleDetail.sections) ? articleDetail.sections : [];
  const generatedAt = new Date().toLocaleString();
  const countStatus = state.countResolver.status === 'ready' ? 'Complete' : state.countResolver.status === 'running' ? 'Still preparing' : 'Not available';
  const referenceStatus = state.referenceResolver.status === 'ready' ? 'Complete' : state.referenceResolver.status === 'running' ? 'Still preparing' : 'Not available';

  return `
    <div class="text-body">
      <div class="d-flex flex-column flex-md-row justify-content-between gap-3 mb-4">
        <div>
          <div class="text-secondary small">DeskReview feedback report</div>
          <h3 class="h4 mb-1">${escapeHtml(state.file?.name || state.runtime.fileName || 'Manuscript review')}</h3>
          <div class="small text-secondary">${escapeHtml(formatInteger(counts.pages))} pages · generated ${escapeHtml(generatedAt)}</div>
        </div>
        <div class="text-md-end small text-secondary">
          <div>Article counts: ${escapeHtml(countStatus)}</div>
          <div>Reference details: ${escapeHtml(referenceStatus)}</div>
        </div>
      </div>

      <div class="row g-3 mb-3">
        ${reportCountCard('Authors', semantic.authorCount, 'authors')}
        ${reportCountCard('Affiliations', semantic.affiliationCount, 'affiliations')}
        ${reportCountCard('Keywords', semantic.keywordCount, 'keywords')}
        ${reportCountCard('Tables', counts.tables, 'tables', 'OCR4 blocks/assets')}
        ${reportCountCard('Figures', counts.figures, 'figures', 'OCR4 blocks/assets')}
        ${reportCountCard('Abstract', semantic.abstractWordCount, 'words')}
        ${reportCountCard('Article text', semantic.articleWordCount, 'words')}
        ${reportCountCard('References', semantic.referenceCount, 'refs')}
      </div>

      ${reportList('Authors', reportItems('authors'), 'No author details were returned yet.')}
      ${reportList('Affiliations', reportItems('affiliations'), 'No affiliation details were returned yet.')}
      ${reportList('Keywords', reportItems('keywords'), 'No keyword details were returned yet.')}

      <div class="card border-0 shadow-sm mb-3">
        <div class="card-body p-3">
          <div class="d-flex align-items-center justify-content-between gap-3 mb-2">
            <div class="small fw-bold text-body">Abstract text counted</div>
            <span class="badge text-bg-light">${escapeHtml(metricValue(abstractDetail.count))} words</span>
          </div>
          ${reportWarnings(abstractDetail.warnings)}
          <div class="small lh-lg">${escapeHtml(abstractDetail.countedText || 'No abstract counted text was returned yet.')}</div>
        </div>
      </div>

      <div class="card border-0 shadow-sm mb-3">
        <div class="card-body p-3">
          <div class="d-flex align-items-center justify-content-between gap-3 mb-2">
            <div class="small fw-bold text-body">Article text counted</div>
            <span class="badge text-bg-light">${escapeHtml(metricValue(articleDetail.count))} words</span>
          </div>
          ${reportWarnings(articleDetail.warnings)}
          ${articleSections.length ? `
            <div class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th scope="col">Section</th>
                    <th scope="col" class="text-end">Words</th>
                  </tr>
                </thead>
                <tbody>
                  ${articleSections.map((section) => `
                    <tr>
                      <td>${escapeHtml(section.title || 'Untitled section')}</td>
                      <td class="text-end">${escapeHtml(metricValue(section.count))}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : '<div class="text-secondary small">No article section details were returned yet.</div>'}
        </div>
      </div>

      <div class="card border-0 shadow-sm mb-3">
        <div class="card-body p-3">
          <div class="d-flex align-items-center justify-content-between gap-3 mb-2">
            <div class="small fw-bold text-body">References</div>
            <span class="badge text-bg-light">${escapeHtml(metricValue(referenceEntries.length || referencesDetail.count))}</span>
          </div>
          ${reportWarnings(referencesDetail.warnings)}
          ${referenceEntries.length ? `
            <div class="list-group list-group-flush">
              ${referenceEntries.map((entry) => `
                <div class="list-group-item px-0">
                  <div class="d-flex align-items-center justify-content-between gap-3 mb-1">
                    <div class="small fw-semibold">Reference ${escapeHtml(entry.number || '')}</div>
                    <span class="badge text-bg-light">${escapeHtml(metricValue((entry.citationOccurrences || []).length))} uses</span>
                  </div>
                  <div class="small mb-2">${escapeHtml(entry.rawText || '')}</div>
                  ${(entry.citationOccurrences || []).slice(0, 3).map((occurrence) => `
                    <div class="small text-secondary border-start ps-2 mb-1">${escapeHtml(occurrence.contextQuote || occurrence.citationText || '')}</div>
                  `).join('')}
                  ${(entry.citationOccurrences || []).length > 3 ? `<div class="small text-secondary">${escapeHtml((entry.citationOccurrences || []).length - 3)} more citation uses</div>` : ''}
                </div>
              `).join('')}
            </div>
          ` : '<div class="text-secondary small">No reference details were returned yet.</div>'}
        </div>
      </div>

      <div class="card border-0 shadow-sm mb-3">
        <div class="card-body p-3">
          <div class="small fw-bold text-body mb-2">Tables and figures</div>
          <div class="row g-2">
            <div class="col-sm-6">
              <div class="border rounded p-3 bg-body">
                <div class="small text-secondary">Tables</div>
                <div class="fs-5 fw-semibold">${escapeHtml(metricValue(counts.tables))}</div>
              </div>
            </div>
            <div class="col-sm-6">
              <div class="border rounded p-3 bg-body">
                <div class="small text-secondary">Figures</div>
                <div class="fs-5 fw-semibold">${escapeHtml(metricValue(counts.figures))}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card border-0 shadow-sm">
        <div class="card-body p-3">
          <div class="small fw-bold text-body mb-2">Reporting guidelines</div>
          <div class="text-secondary small">Reporting guideline checks will be added to this report when that section is available.</div>
        </div>
      </div>
    </div>
  `;
}

function renderFeedbackReport() {
  if (!els.feedbackReportBody) return;
  if (!state.pages.length) {
    els.feedbackReportBody.innerHTML = '<div class="text-secondary small">Open a manuscript review to generate a feedback report.</div>';
    return;
  }
  els.feedbackReportBody.innerHTML = feedbackReportHtml();
}

function feedbackReportPrintDocument() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeskReview feedback report</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background: #f6f6f7; color: #27272a; }
    @media print {
      body { background: #fff; }
      .card { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="container py-4">
    ${feedbackReportHtml()}
  </main>
  <script>
    window.addEventListener('load', () => window.setTimeout(() => window.print(), 250));
  </script>
</body>
</html>`;
}

function openFeedbackReportPdf() {
  renderFeedbackReport();
  const reportWindow = window.open('', '_blank');
  if (!reportWindow) return;
  reportWindow.document.open();
  reportWindow.document.write(feedbackReportPrintDocument());
  reportWindow.document.close();
}

function clearCheckRevealTimers() {
  (state.checkReveal.timers || []).forEach((timer) => window.clearTimeout(timer));
  if (state.checkReveal.resultTimer) window.clearTimeout(state.checkReveal.resultTimer);
  state.checkReveal.timers = [];
  state.checkReveal.resultTimer = 0;
}

function startCheckReveal() {
  clearCheckRevealTimers();
  const now = runtimeNow();
  state.checkReveal = {
    phase: 'revealing',
    startedAt: now,
    visibleKinds: [...COUNT_TILE_ORDER],
    resultKinds: [],
    lastResultAt: now,
    resultTimer: 0,
    timers: []
  };
  state.tileReady = {};
  state.tilePulseUntil = {};
  markRuntime('Checks panel preparing');
  renderCounts();
  const timer = window.setTimeout(() => {
    state.checkReveal.phase = 'active';
    renderCounts();
    maybeQueueResultReveal();
  }, COUNT_TILE_ENTRANCE_MS + 120);
  state.checkReveal.timers.push(timer);
}

function tileIsVisible(kind = '') {
  if (state.checkReveal.phase === 'idle') return true;
  return state.checkReveal.visibleKinds.includes(kind);
}

function resultIsReleased(kind = '') {
  if (state.checkReveal.phase === 'idle') return true;
  return state.checkReveal.resultKinds.includes(kind);
}

function hasCountValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function tileHasResolvedValue(kind = '') {
  const semantic = state.semanticCounts || {};
  if (kind === 'tables' || kind === 'figures') return state.pages.length > 0;
  if (['authors', 'affiliations', 'keywords', 'abstract', 'article'].includes(kind) && state.countResolver.status === 'failed') return true;
  if (['authors', 'affiliations', 'keywords'].includes(kind) && state.countResolver.status === 'ready') return true;
  if (kind === 'authors') return hasCountValue(semantic.authorCount);
  if (kind === 'affiliations') return hasCountValue(semantic.affiliationCount);
  if (kind === 'keywords') return hasCountValue(semantic.keywordCount);
  if (kind === 'abstract') return hasCountValue(semantic.abstractWordCount);
  if (kind === 'article') return hasCountValue(semantic.articleWordCount);
  if (kind === 'references' && state.referenceResolver.status === 'failed') return true;
  if (kind === 'references') return hasCountValue(semantic.referenceCount);
  return false;
}

function maybeQueueResultReveal() {
  if (!state.pages.length || state.checkReveal.phase === 'idle' || state.checkReveal.phase === 'revealing') return;
  if (state.checkReveal.resultTimer) return;
  const nextKind = COUNT_TILE_ORDER.find((kind) => (
    tileIsVisible(kind) &&
    !resultIsReleased(kind) &&
    tileHasResolvedValue(kind)
  ));
  if (!nextKind) return;
  const now = runtimeNow();
  const delay = Math.max(0, Number(state.checkReveal.lastResultAt || now) + COUNT_RESULT_GAP_MS - now);
  const timer = window.setTimeout(() => {
    state.checkReveal.resultTimer = 0;
    if (!state.checkReveal.resultKinds.includes(nextKind)) {
      state.checkReveal.resultKinds.push(nextKind);
      state.checkReveal.lastResultAt = runtimeNow();
      markRuntime('Check tile value revealed', { tile: nextKind });
    }
    renderCounts();
    maybeQueueResultReveal();
  }, delay);
  state.checkReveal.resultTimer = timer;
  state.checkReveal.timers.push(timer);
}

function tilePulseClass(kind = '', isReady = false) {
  const wasReady = Boolean(state.tileReady[kind]);
  if (isReady && !wasReady) {
    state.tilePulseUntil[kind] = runtimeNow() + 1400;
  }
  state.tileReady[kind] = Boolean(isReady);
  return runtimeNow() < Number(state.tilePulseUntil[kind] || 0) ? ' tile-arrived' : '';
}

function startProgressTicker() {
  if (state.progressTimer) return;
  state.progressTimer = window.setInterval(() => {
    if (state.ocrProgress.status === 'running') {
      const elapsed = performance.now() - state.ocrProgress.startedAt;
      const remaining = Math.max(0, state.ocrProgress.estimateMs - elapsed);
      setStatus(`Parsing · ${formatEta(remaining)}`, 'running');
      if (!state.pages.length) renderLoadingHtml();
    } else if (state.countResolver.status === 'running' || state.referenceResolver.status === 'running') {
      updateBackgroundStatus();
      if (state.countResolver.status === 'running') {
        ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
          state.detailCache.set(kind, buildCountsPendingDetail(kind));
        });
      }
      renderCounts();
      ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
        if (state.activeDetailKind === kind) renderSemanticDetail(kind, state.detailCache.get(kind));
      });
      if (state.activeDetailKind === 'references') renderSemanticDetail('references', state.detailCache.get('references'));
    } else {
      stopProgressTicker();
    }
  }, 1000);
}

function stopProgressTicker() {
  if (!state.progressTimer) return;
  window.clearInterval(state.progressTimer);
  state.progressTimer = 0;
}

function updateBackgroundStatus() {
  const countRunning = state.countResolver.status === 'running';
  const referenceRunning = state.referenceResolver.status === 'running';
  if (state.ocrProgress.status === 'running') return;
  if (countRunning && referenceRunning) {
    setStatus('OCR ready · preparing checks', 'running');
    return;
  }
  if (countRunning) {
    setStatus('OCR ready · resolving counts', 'running');
    return;
  }
  if (referenceRunning) {
    const total = Number(state.referenceResolver.total || 0);
    const completed = Number(state.referenceResolver.completed || 0);
    setStatus(total ? `OCR ready · references ${completed}/${total}` : 'OCR ready · resolving references', 'running');
    return;
  }
  if (state.pages.length) setStatus('Ready', 'done');
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0MB';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)}KB`;
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}

function formatInteger(value = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatDateTime(value = '') {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function pageIndex(page = {}, fallback = 0) {
  const value = Number(page.index ?? page.page_index ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function reviewCountsSummary(review = {}) {
  const counts = review.ocr?.semanticCounts || {};
  const pages = Array.isArray(review.ocr?.pages) ? review.ocr.pages : [];
  const ocrBlocks = pages.flatMap((page) => getBlocks(page));
  const tableAssets = pages.reduce((sum, page) => sum + (Array.isArray(page.tables) ? page.tables.length : 0), 0);
  const figureAssets = pages.reduce((sum, page) => sum + (Array.isArray(page.images) ? page.images.length : 0), 0);
  const tableBlocks = ocrBlocks.filter((block) => blockType(block) === 'table').length;
  const figureBlocks = ocrBlocks.filter((block) => blockType(block) === 'image' || blockType(block) === 'figure').length;
  const reviewBlocks = Array.isArray(review.ocr?.pages)
    ? review.ocr.pages.flatMap((page, pagePosition) => getBlocks(page).map((block, blockIndex) => ({
      key: `block-${pageIndex(page)}-${blockIndex}`,
      text: blockText(block),
      plainText: ocrPlainText(blockText(block))
    })))
    : [];
  const resolvedCounts = review.countResolver?.status === 'ready' && review.countResolver.result
    ? buildCountsDetailsFromResolvedMap(review.countResolver.result, reviewBlocks)
    : null;
  const parts = [];
  if (resolvedCounts) {
    parts.push(`Abstract ${formatInteger(resolvedCounts.abstract.detail.count)}`);
    parts.push(`Article ${formatInteger(resolvedCounts.article.detail.count)}`);
  }
  if (review.referenceResolver?.status === 'ready' && Array.isArray(review.referenceResolver.result?.entries)) {
    parts.push(`${formatInteger(review.referenceResolver.result.entries.length)} refs`);
  } else if (Number.isFinite(Number(counts.referenceCount))) {
    parts.push(`${formatInteger(counts.referenceCount)} refs`);
  }
  const tableCount = Number.isFinite(Number(counts.tableCount)) ? Number(counts.tableCount) : Math.max(tableAssets, tableBlocks);
  const figureCount = Number.isFinite(Number(counts.figureCount)) ? Number(counts.figureCount) : Math.max(figureAssets, figureBlocks);
  if (tableCount) parts.push(`${formatInteger(tableCount)} tables`);
  if (figureCount) parts.push(`${formatInteger(figureCount)} figures`);
  return parts.join(' · ') || 'Counts unavailable';
}

function renderStoredReviews(reviews = []) {
  state.library = reviews;
  if (!reviews.length) {
    els.reviewLibraryBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-5">
          <div class="text-secondary mb-2"><i class="bi bi-archive fs-3"></i></div>
          <div class="fw-medium">No stored desk reviews yet</div>
          <div class="small text-secondary">Upload a PDF once; the OCR4 result will be stored here for UI testing.</div>
        </td>
      </tr>
    `;
    return;
  }
  els.reviewLibraryBody.innerHTML = reviews.map((review) => `
    <tr class="library-row" data-review-id="${escapeHtml(review.id)}" role="button" tabindex="0">
      <td class="small text-secondary">
        <div class="text-truncate" style="max-width: 34rem;">${escapeHtml(review.fileName || 'manuscript.pdf')}</div>
      </td>
      <td class="small text-secondary">${escapeHtml(formatInteger(review.pageCount || 0))}</td>
      <td class="small text-secondary">${escapeHtml(reviewCountsSummary(review))}</td>
      <td class="small text-secondary">${escapeHtml(formatDateTime(review.updatedAt || review.createdAt))}</td>
      <td class="text-end">
        <button type="button" class="btn btn-sm btn-outline-danger" data-delete-review-id="${escapeHtml(review.id)}" aria-label="Delete ${escapeHtml(review.fileName || 'stored review')}">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function showDeleteReviewModal(reviewId = '') {
  const review = state.library.find((item) => item.id === reviewId);
  state.pendingDeleteReviewId = reviewId;
  if (els.deleteReviewName) {
    els.deleteReviewName.textContent = review?.fileName ? review.fileName : 'Stored review';
  }
  const modal = window.bootstrap?.Modal?.getOrCreateInstance(els.deleteReviewModal);
  modal?.show();
}

async function refreshLibrary() {
  try {
    renderStoredReviews(await listStoredReviews());
  } catch (error) {
    console.error(error);
    els.reviewLibraryBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-danger py-5">Could not load stored desk reviews.</td>
      </tr>
    `;
  }
}

function showHome() {
  els.homeView.classList.remove('d-none');
  els.reader.classList.add('d-none');
}

function showReader() {
  els.homeView.classList.add('d-none');
  els.reader.classList.remove('d-none');
}

function pageNumber(page = {}, fallback = 0) {
  return pageIndex(page, fallback) + 1;
}

function getBlocks(page = {}) {
  if (Array.isArray(page.blocks)) return page.blocks;
  if (Array.isArray(page.ocr_blocks)) return page.ocr_blocks;
  return [];
}

function blockText(block = {}) {
  return String(block.content || block.text || block.markdown || block.html || '').trim();
}

function blockType(block = {}) {
  return String(block.type || block.block_type || block.category || 'text').trim().toLowerCase() || 'text';
}

function blockBox(block = {}) {
  const left = Number(block.top_left_x ?? block.topLeftX ?? block.bbox?.left ?? block.bounding_box?.left ?? block.x ?? 0) || 0;
  const top = Number(block.top_left_y ?? block.topLeftY ?? block.bbox?.top ?? block.bounding_box?.top ?? block.y ?? 0) || 0;
  const right = Number(block.bottom_right_x ?? block.bottomRightX ?? block.bbox?.right ?? block.bounding_box?.right ?? (block.x != null && block.width != null ? Number(block.x) + Number(block.width) : 0)) || 0;
  const bottom = Number(block.bottom_right_y ?? block.bottomRightY ?? block.bbox?.bottom ?? block.bounding_box?.bottom ?? (block.y != null && block.height != null ? Number(block.y) + Number(block.height) : 0)) || 0;
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function pageDimensions(page = {}, pageView = null) {
  const dimensions = page.dimensions || page.dimension || {};
  const width = Number(dimensions.width || dimensions.page_width || dimensions.w || page.width || 0) || 0;
  const height = Number(dimensions.height || dimensions.page_height || dimensions.h || page.height || 0) || 0;
  if (width && height) return { width, height };
  if (pageView) {
    return {
      width: pageView.viewport.width / state.zoom,
      height: pageView.viewport.height / state.zoom
    };
  }
  return { width: 1, height: 1 };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

async function runOcr(file) {
  const base64 = await fileToBase64(file);
  const started = runtimeNow();
  markRuntime('OCR request started', { size: formatBytes(file?.size || 0) });
  const data = await requestOcr({
    fileName: file.name,
    mimeType: file.type || 'application/pdf',
    base64
  });
  markRuntime('OCR request finished', {
    wallMs: Math.round(runtimeNow() - started),
    apiMs: Number(data.elapsedMs || 0),
    pages: Array.isArray(data.pages) ? data.pages.length : 0
  });
  return data;
}

async function resolveReferencesWithCompletion(referenceBlocks = [], options = {}) {
  const started = runtimeNow();
  const data = await resolveReferences(referenceBlocks, options);
  markRuntime('Reference batch finished', {
    wallMs: Math.round(runtimeNow() - started),
    apiMs: Number(data.elapsedMs || 0),
    blocks: referenceBlocks.length,
    entries: Array.isArray(data.result?.entries) ? data.result.entries.length : 0,
    inferredRegion: Boolean(options.inferBibliographyRegion)
  });
  return data;
}

async function resolveCountsWithCompletion(blocks = []) {
  const started = runtimeNow();
  const data = await resolveCounts(blocks);
  markRuntime('Word-count resolver finished', {
    wallMs: Math.round(runtimeNow() - started),
    apiMs: Number(data.elapsedMs || 0),
    blocks: blocks.length
  });
  return data;
}

async function resolveDisplayItemsWithCompletion(displayItems = [], bodyBlocks = []) {
  const started = runtimeNow();
  const data = await resolveDisplayItems(displayItems, bodyBlocks);
  markRuntime('Table/figure resolver finished', {
    wallMs: Math.round(runtimeNow() - started),
    apiMs: Number(data.elapsedMs || 0),
    displayItems: displayItems.length,
    bodyBlocks: bodyBlocks.length
  });
  return data;
}

async function annotateDocumentWithCompletion(payload = {}) {
  const started = runtimeNow();
  const data = await annotateDocument(payload);
  markRuntime('Document annotation finished', {
    wallMs: Math.round(runtimeNow() - started),
    apiMs: Number(data.elapsedMs || 0),
    blocks: Array.isArray(payload.blocks) ? payload.blocks.length : 0
  });
  return data;
}

function renderLoadingHtml() {
  renderLoadingToc();
  renderLoadingCounts();
  els.htmlDocument.innerHTML = `
    <div class="p-4">
      ${renderProgressCard({
        title: 'OCR4 is parsing the manuscript',
        message: 'The HTML manuscript, section labels, tables, and figures will appear as soon as OCR4 returns the page blocks.',
        progress: boundedProgress(state.ocrProgress.startedAt ? performance.now() - state.ocrProgress.startedAt : 0, state.ocrProgress.estimateMs),
        eta: state.ocrProgress.startedAt ? formatEta(Math.max(0, state.ocrProgress.estimateMs - (performance.now() - state.ocrProgress.startedAt))) : ''
      })}
      <div class="loading-lines" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  `;
}

function pdfFitScale(baseViewport = null) {
  const viewportWidth = Number(baseViewport?.width || 0);
  const availableWidth = Math.max(320, Number(els.pdfScroll?.clientWidth || 0) - 24);
  if (!viewportWidth) return 1;
  return availableWidth / viewportWidth;
}

function schedulePdfFitRender(delay = 140) {
  window.clearTimeout(state.pdfResizeTimer);
  state.pdfResizeTimer = window.setTimeout(() => {
    if (!state.pdfUrl || state.activeView !== 'pdf') return;
    renderPdfDocument().catch((error) => console.warn('[deskreview-mistral-2] PDF fit render failed', error));
  }, delay);
}

async function renderPdfDocument() {
  if (!state.pdfUrl) return;
  const token = state.pdfRenderToken + 1;
  state.pdfRenderToken = token;
  state.pageViews.clear();
  els.pdfDocument.innerHTML = '';

  const loadingTask = pdfjsLib.getDocument({ url: state.pdfUrl });
  state.pdfDoc = await loadingTask.promise;
  if (token !== state.pdfRenderToken) return;

  for (let pageNumberValue = 1; pageNumberValue <= state.pdfDoc.numPages; pageNumberValue += 1) {
    if (token !== state.pdfRenderToken) return;
    const page = await state.pdfDoc.getPage(pageNumberValue);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = pdfFitScale(baseViewport);
    const viewport = page.getViewport({ scale });
    state.zoom = scale;
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.pdfPage = String(pageNumberValue);
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const outputScale = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrapper.appendChild(canvas);
    els.pdfDocument.appendChild(wrapper);

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    }).promise;
    if (token !== state.pdfRenderToken) return;
    state.pageViews.set(pageNumberValue, { wrapper, viewport });
    if (state.activeBlockKey) drawActivePdfRegion(state.activeBlockKey);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
}

function clearPdfBlockRegions() {
  document.querySelectorAll('.pdf-region').forEach((node) => node.remove());
}

function renderAllRegions() {
  clearPdfBlockRegions();
  if (state.activeBlockKey) drawActivePdfRegion(state.activeBlockKey);
}

function imageSource(image = {}) {
  const value = String(image.image_base64 || image.imageBase64 || image.base64 || image.data || image.url || '').trim();
  if (!value) return '';
  if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
  return `data:image/jpeg;base64,${value}`;
}

function assetName(value = '') {
  return String(value || '').split('/').pop().trim();
}

function findTableAsset(page = {}, href = '') {
  const name = assetName(href);
  return (Array.isArray(page.tables) ? page.tables : []).find((table, index) => {
    const ids = [table.id, table.table_id, table.name, `tbl-${index}.html`].map(assetName);
    return ids.includes(name);
  });
}

function findImageAsset(page = {}, href = '') {
  const name = assetName(href);
  return (Array.isArray(page.images) ? page.images : []).find((image, index) => {
    const ids = [image.id, image.image_id, image.name, `img-${index}.jpeg`, `img-${index}.jpg`, `img-${index}.png`].map(assetName);
    return ids.includes(name);
  });
}

function renderInline(value = '') {
  let html = escapeHtml(value);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

function renderMarkdownTable(rows = []) {
  const cleanRows = rows.filter((line) => !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim()));
  if (!cleanRows.length) return '';
  return `<div class="table-responsive"><table><tbody>${cleanRows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? 'th' : 'td';
    const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    return `<tr>${cells.map((cell) => `<${tag}>${renderInline(cell)}</${tag}>`).join('')}</tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderAssetMarkdown(line = '', page = {}) {
  const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (imageMatch) {
    const image = findImageAsset(page, imageMatch[2]);
    const src = imageSource(image || {});
    if (!src) return `<p>${renderInline(line)}</p>`;
    return `<figure class="my-3"><img class="ocr-image" src="${escapeHtml(src)}" alt="${escapeHtml(imageMatch[1] || 'OCR image')}"></figure>`;
  }
  const linkMatch = line.match(/^\[([^\]]+\.html)\]\(([^)]+\.html)\)\s*$/i);
  if (linkMatch) {
    const table = findTableAsset(page, linkMatch[2]);
    const html = sanitizeMistralHtml(table?.html || table?.table_html || table?.tableHtml || '');
    if (html) return `<div class="table-responsive">${html}</div>`;
  }
  return '';
}

function markdownToHtml(markdown = '', page = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let table = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    html.push(renderMarkdownTable(table));
    table = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    const asset = renderAssetMarkdown(trimmed, page);
    if (asset) {
      flushParagraph();
      flushTable();
      html.push(asset);
      return;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph();
      flushTable();
      const level = Math.min(6, heading[1].length);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      return;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph();
      table.push(trimmed);
      return;
    }
    if (!trimmed) {
      flushParagraph();
      flushTable();
      return;
    }
    paragraph.push(trimmed);
  });
  flushParagraph();
  flushTable();
  return html.join('\n') || '<p class="text-secondary">No OCR text returned for this block.</p>';
}

function renderBlockContent(block = {}, page = {}) {
  const content = blockText(block);
  const html = String(block.html || block.table_html || block.tableHtml || (
    /^<(table|figure|img)\b/i.test(content) ? content : ''
  )).trim();
  if (html) return `<div class="table-responsive">${sanitizeMistralHtml(html)}</div>`;
  return markdownToHtml(content, page);
}

function registerBlockTarget(key = '', page = {}, block = {}, blockIndex = 0) {
  state.blockTargets.set(key, {
    key,
    pageNumber: pageNumber(page),
    pageIndex: pageIndex(page),
    blockIndex,
    box: blockBox(block),
    type: blockType(block),
    text: blockText(block)
  });
}

function renderBlock(page = {}, block = {}, blockIndex = 0) {
  const key = `block-${pageIndex(page)}-${blockIndex}`;
  const type = blockType(block);
  registerBlockTarget(key, page, block, blockIndex);
  return `
    <div id="${escapeHtml(key)}" data-block-id="${escapeHtml(key)}" data-block-type="${escapeHtml(type)}" class="ocr-block" tabindex="0">
      ${renderBlockContent(block, page)}
    </div>
  `;
}

function renderPage(page = {}, position = 0) {
  const blocks = getBlocks(page);
  const number = pageNumber(page, position);
  const body = blocks.length
    ? blocks.map((block, index) => renderBlock(page, block, index)).join('')
    : renderBlock({ ...page, index: number - 1 }, { type: 'page', markdown: page.markdown || page.text || '' }, 0);
  return `
    <section class="ocr-page" data-html-page="${number}">
      <div class="page-strip">
        <span class="page-pill">Page ${number} of ${state.pages.length}</span>
      </div>
      ${body}
    </section>
  `;
}

function renderEmptyToc(message = 'Section headings will appear here.') {
  state.tocEntries = [];
  els.tocList.innerHTML = `
    <div class="empty-state toc-empty">
      <i class="bi bi-list-ul"></i>
      <div>${escapeHtml(message)}</div>
    </div>
  `;
}

function renderLoadingToc() {
  state.tocEntries = [];
  els.tocList.innerHTML = `
    <div class="card border-0 shadow-sm mb-2">
      <div class="card-body p-3">
        <div class="d-flex align-items-center gap-2 small fw-semibold">
          ${statusSpinner()}
          <span>Reading sections</span>
        </div>
        <div class="small text-secondary mt-2">Headings will appear as soon as OCR4 returns the manuscript structure.</div>
      </div>
    </div>
    ${Array.from({ length: 9 }).map((_, index) => `
      <div class="toc-shimmer-row" style="--indent: ${index > 0 && index % 3 ? '1.1rem' : '0rem'};">
        <span></span>
      </div>
    `).join('')}
  `;
}

function renderEmptyCounts(message = 'OCR4 summary counts will appear here.') {
  els.countsGrid.innerHTML = `
    <div class="empty-state counts-empty">
      <i class="bi bi-grid-3x2-gap"></i>
      <div>${escapeHtml(message)}</div>
    </div>
  `;
}

function renderProgressCard({ title = '', message = '', progress = null, eta = '', tone = 'primary' } = {}) {
  const hasProgress = Number.isFinite(Number(progress));
  const width = hasProgress ? Math.max(4, Math.min(100, Number(progress))) : 100;
  return `
    <div class="card border-0 shadow-sm counts-grid-span">
      <div class="card-body p-3">
        <div class="d-flex align-items-center justify-content-between gap-2">
          <div class="d-flex align-items-center gap-2 small fw-semibold">
            ${statusSpinner()}
            <span>${escapeHtml(title)}</span>
          </div>
          ${eta ? `<span class="small text-secondary text-nowrap">${escapeHtml(eta)}</span>` : ''}
        </div>
        ${message ? `<div class="small text-secondary mt-2">${escapeHtml(message)}</div>` : ''}
        <div class="progress mt-3" role="progressbar" aria-label="${escapeHtml(title)}" aria-valuenow="${hasProgress ? escapeHtml(Math.round(width)) : ''}" aria-valuemin="0" aria-valuemax="100" style="height: 0.35rem;">
          <div class="progress-bar ${hasProgress ? `bg-${escapeHtml(tone)}` : 'progress-bar-striped progress-bar-animated bg-secondary'}" style="width: ${escapeHtml(width)}%;"></div>
        </div>
      </div>
    </div>
  `;
}

function renderLoadingCounts() {
  const elapsed = state.ocrProgress.startedAt ? performance.now() - state.ocrProgress.startedAt : 0;
  const progress = boundedProgress(elapsed, state.ocrProgress.estimateMs);
  const eta = formatEta(Math.max(0, state.ocrProgress.estimateMs - elapsed));
  els.countsGrid.innerHTML = `
    ${renderProgressCard({
      title: 'Parsing manuscript',
      message: 'OCR4 is preparing the HTML manuscript, section labels, tables, and figures.',
      progress,
      eta
    })}
  `;
}

function collectTocEntries() {
  const entries = [...els.htmlDocument.querySelectorAll('.ocr-block h1, .ocr-block h2, .ocr-block h3, .ocr-block h4, .ocr-block h5, .ocr-block h6')]
    .map((heading, index) => {
      const block = heading.closest('[data-block-id]');
      const blockKey = block?.dataset.blockId || '';
      const target = state.blockTargets.get(blockKey);
      return {
        id: `toc-${index}`,
        blockKey,
        label: String(heading.textContent || '').trim(),
        level: Number(heading.tagName.slice(1)) || 1,
        pageNumber: target?.pageNumber || 0
      };
    })
    .filter((entry) => entry.blockKey && entry.label);
  return projectTocEntries(entries);
}

function renderToc() {
  state.tocEntries = collectTocEntries();
  if (!state.tocEntries.length) {
    renderEmptyToc('No OCR4 headings were returned for this manuscript.');
    return;
  }
  els.tocList.innerHTML = state.tocEntries.map((entry, index) => {
    const padding = Math.min(2.5, Math.max(0, entry.level - 1) * 0.7);
    const label = entry.displayLabel || entry.label;
    return `
      <button type="button" class="toc-button" data-toc-block-key="${escapeHtml(entry.blockKey)}" style="padding-left: ${0.5 + padding}rem;">
        <span class="toc-label">${escapeHtml(label)}</span>
      </button>
    `;
  }).join('');
}

function syncActiveToc(key = '') {
  els.tocList.querySelectorAll('[data-toc-block-key]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tocBlockKey === key);
  });
}

function getOcrCounts() {
  const blocks = state.pages.flatMap((page) => getBlocks(page));
  const words = blocks.reduce((sum, block) => {
    const text = blockText(block).replace(/<[^>]*>/g, ' ');
    return sum + (text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length;
  }, 0);
  const tableAssets = state.pages.reduce((sum, page) => sum + (Array.isArray(page.tables) ? page.tables.length : 0), 0);
  const tableBlocks = blocks.filter((block) => blockType(block) === 'table').length;
  const figureAssets = state.pages.reduce((sum, page) => sum + (Array.isArray(page.images) ? page.images.length : 0), 0);
  const figureBlocks = blocks.filter((block) => blockType(block) === 'image' || blockType(block) === 'figure').length;
  const resolvedDisplayItems = displayResolverReadyItems();
  const resolvedTables = resolvedDisplayItems.filter((item) => item.kind === 'table').length;
  const resolvedFigures = resolvedDisplayItems.filter((item) => item.kind === 'figure').length;
  return {
    pages: state.pages.length,
    words,
    headings: state.tocEntries.length,
    blocks: blocks.length,
    tables: state.displayResolver.status === 'ready' ? resolvedTables : Math.max(tableAssets, tableBlocks),
    figures: state.displayResolver.status === 'ready' ? resolvedFigures : Math.max(figureAssets, figureBlocks)
  };
}

function metricValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  return Number.isFinite(Number(value)) ? formatInteger(value) : '-';
}

function renderCountResultBar(resultBar = null, label = '') {
  if (!Array.isArray(resultBar?.segments) || !resultBar.segments.length) return '';
  return `
    <div class="count-result-bar progress mt-2" role="progressbar" aria-label="${escapeHtml(label || 'Count benchmark')}" title="${escapeHtml(resultBar.tooltip || '')}">
      ${resultBar.segments.map((segment) => `
        <div class="progress-bar ${escapeHtml(segment.className || 'bg-body-secondary')}" style="width: ${escapeHtml(segment.width)}%;" aria-label="${escapeHtml(segment.label || '')}"></div>
      `).join('')}
    </div>
  `;
}

function renderCountTile({ kind = '', label = '', value = null, unit = '', status = 'ready', progress = null, resultBar = null, tileIndex = 0 } = {}) {
  const isBusy = status === 'running' || status === 'pending';
  const hasProgress = Number.isFinite(Number(progress));
  const progressWidth = hasProgress ? Math.max(4, Math.min(100, Number(progress))) : 100;
  const pulseClass = tilePulseClass(kind, !isBusy && value !== null && value !== undefined);
  const revealClass = state.checkReveal.phase === 'revealing' ? ' tile-revealing' : '';
  const barLabel = `${label || kind || 'Count'} benchmark`;
  return `
    <button type="button" class="count-tile ${isBusy ? 'is-busy' : ''}${pulseClass}${revealClass}" data-count-kind="${escapeHtml(kind)}" style="--tile-index: ${escapeHtml(tileIndex)};" ${isBusy ? 'aria-busy="true"' : ''}>
      ${(label || isBusy) ? `
        <div class="count-label">
          ${label ? `<span>${escapeHtml(label)}</span>` : '<span></span>'}
          ${isBusy ? statusSpinner() : ''}
        </div>
      ` : ''}
      <div class="d-flex align-items-baseline gap-2">
        <div class="count-value ${isBusy && value === null ? 'count-value-pending' : ''}">${escapeHtml(metricValue(value))}</div>
        ${unit ? `<div class="small text-secondary">${escapeHtml(unit)}</div>` : ''}
      </div>
      ${isBusy ? `
        <div class="progress mt-2" role="progressbar" aria-label="${escapeHtml(label)} progress" style="height: 0.28rem;">
          <div class="progress-bar soft-progress ${hasProgress ? '' : 'progress-bar-striped progress-bar-animated'}" style="width: ${escapeHtml(progressWidth)}%;"></div>
        </div>
      ` : renderCountResultBar(resultBar, barLabel)}
    </button>
  `;
}

function renderCounts() {
  if (!state.pages.length) {
    renderEmptyCounts();
    return;
  }
  if (state.checkReveal.phase === 'preparing') {
    els.countsGrid.innerHTML = renderProgressCard({
      title: 'Preparing checks',
      message: 'The manuscript is ready. Checks will appear here as they are prepared.',
      progress: null
    });
    return;
  }
  const counts = getOcrCounts();
  const semantic = state.semanticCounts || {};
  const referenceTotal = Number(state.referenceResolver.total || 0);
  const referenceCompleted = Number(state.referenceResolver.completed || 0);
  const referenceProgress = referenceTotal ? Math.round((referenceCompleted / referenceTotal) * 100) : null;
  const releasedValue = (kind, value) => (resultIsReleased(kind) ? value : null);
  const releasedStatus = (kind) => (resultIsReleased(kind) ? 'ready' : 'running');
  const releasedResultBar = (kind, value, unit) => {
    const benchmark = countBenchmarkForKind(kind);
    const count = releasedValue(kind, value);
    if (!benchmark || count === null || count === undefined) return null;
    return buildCountProgress({
      count,
      limit: benchmark.limit,
      unit: unit || benchmark.unit,
      sourceLabel: benchmark.sourceLabel
    });
  };
  const tiles = [
    ['authors', renderCountTile({ kind: 'authors', value: releasedValue('authors', semantic.authorCount), unit: 'authors', status: releasedStatus('authors'), tileIndex: 0 })],
    ['affiliations', renderCountTile({ kind: 'affiliations', value: releasedValue('affiliations', semantic.affiliationCount), unit: 'affiliations', status: releasedStatus('affiliations'), tileIndex: 1 })],
    ['abstract', renderCountTile({ kind: 'abstract', label: 'Abstract', value: releasedValue('abstract', semantic.abstractWordCount), unit: 'words', status: releasedStatus('abstract'), resultBar: releasedResultBar('abstract', semantic.abstractWordCount, 'words'), tileIndex: 2 })],
    ['article', renderCountTile({ kind: 'article', label: 'Article', value: releasedValue('article', semantic.articleWordCount), unit: 'words', status: releasedStatus('article'), resultBar: releasedResultBar('article', semantic.articleWordCount, 'words'), tileIndex: 3 })],
    ['keywords', renderCountTile({ kind: 'keywords', value: releasedValue('keywords', semantic.keywordCount), unit: 'keywords', status: releasedStatus('keywords'), tileIndex: 4 })],
    ['references', renderCountTile({
      kind: 'references',
      value: releasedValue('references', semantic.referenceCount),
      unit: 'refs',
      status: releasedStatus('references'),
      progress: resultIsReleased('references') ? null : referenceProgress,
      resultBar: releasedResultBar('references', semantic.referenceCount, 'refs'),
      tileIndex: 5
    })],
    ['tables', renderCountTile({ kind: 'tables', value: releasedValue('tables', counts.tables), unit: 'tables', status: releasedStatus('tables'), resultBar: releasedResultBar('tables', counts.tables, 'tables'), tileIndex: 6 })],
    ['figures', renderCountTile({ kind: 'figures', value: releasedValue('figures', counts.figures), unit: 'figures', status: releasedStatus('figures'), resultBar: releasedResultBar('figures', counts.figures, 'figures'), tileIndex: 7 })]
  ];
  els.countsGrid.innerHTML = tiles
    .filter(([kind]) => tileIsVisible(kind))
    .map(([, html]) => html)
    .join('') || renderProgressCard({
      title: 'Preparing checks',
      message: 'Checks will appear here shortly.',
      progress: null
    });
  maybeQueueResultReveal();
}

function guidelineStatusTone(status = '') {
  return {
    present: 'success',
    warning: 'warning',
    absent: 'danger',
    na: 'secondary',
    pending: 'secondary',
    failed: 'danger'
  }[status] || 'secondary';
}

function guidelineStatusLabel(status = '') {
  return {
    present: 'Ready',
    warning: 'Review',
    absent: 'Missing',
    na: 'N/A',
    pending: 'Pending',
    failed: 'Failed'
  }[status] || 'Pending';
}

function updateEssentialResults() {
  if (!state.essentialGuides.length) {
    state.essentialResults = [];
    return;
  }
  state.essentialResults = evaluateEssentialGuides(
    state.essentialGuides,
    state.documentAnnotation.status === 'ready' ? state.documentAnnotation.result : null
  );
}

function renderEssentialGuidelines() {
  if (!els.essentialGuideList) return;
  if (!state.essentialGuides.length) {
    els.essentialGuideList.innerHTML = '<div class="small text-secondary">Essential guidelines are loading.</div>';
    if (els.essentialGuidelineSummary) els.essentialGuidelineSummary.textContent = 'Loading';
    return;
  }
  updateEssentialResults();
  if (state.documentAnnotation.status === 'failed') {
    els.essentialGuideList.innerHTML = `
      <div class="alert alert-light border small mb-0">${escapeHtml(state.documentAnnotation.error || 'Document annotation is unavailable.')}</div>
    `;
    if (els.essentialGuidelineSummary) {
      els.essentialGuidelineSummary.className = 'badge text-bg-danger ms-auto';
      els.essentialGuidelineSummary.textContent = 'Failed';
    }
    return;
  }
  const aggregate = state.essentialResults.reduce((total, guide) => {
    Object.entries(guide.summary || {}).forEach(([key, value]) => {
      total[key] = (total[key] || 0) + Number(value || 0);
    });
    return total;
  }, { present: 0, warning: 0, absent: 0, na: 0 });
  const summaryText = state.documentAnnotation.status === 'ready'
    ? `${aggregate.present}/${Math.max(1, aggregate.present + aggregate.warning + aggregate.absent)}`
    : 'Pending';
  if (els.essentialGuidelineSummary) {
    els.essentialGuidelineSummary.className = `badge text-bg-${guidelineStatusTone(state.documentAnnotation.status === 'ready' ? 'present' : 'pending')} ms-auto`;
    els.essentialGuidelineSummary.textContent = summaryText;
  }
  els.essentialGuideList.innerHTML = state.essentialResults.map((guide) => {
    const tone = guidelineStatusTone(guide.status);
    const summary = guide.summary || {};
    return `
      <button type="button" class="card border shadow-sm text-start w-100 guide-card" data-essential-guide-id="${escapeHtml(guide.id)}">
        <div class="card-body p-3">
          <div class="d-flex align-items-start justify-content-between gap-2">
            <div class="min-w-0">
              <div class="small fw-semibold text-body">${escapeHtml(guide.name || 'Essential guide')}</div>
              <div class="small text-secondary">${escapeHtml(guide.description || '')}</div>
            </div>
            <span class="badge text-bg-${tone}">${escapeHtml(guidelineStatusLabel(guide.status))}</span>
          </div>
          <div class="d-flex flex-wrap gap-1 mt-2">
            <span class="badge bg-success-subtle text-success-emphasis">${escapeHtml(summary.present || 0)} present</span>
            <span class="badge bg-warning-subtle text-warning-emphasis">${escapeHtml(summary.warning || 0)} review</span>
            <span class="badge bg-danger-subtle text-danger-emphasis">${escapeHtml(summary.absent || 0)} missing</span>
            <span class="badge bg-secondary-subtle text-secondary-emphasis">${escapeHtml(summary.na || 0)} n/a</span>
          </div>
        </div>
      </button>
    `;
  }).join('');
}

function renderEssentialGuideDetails(guideId = '') {
  updateEssentialResults();
  const guide = state.essentialResults.find((item) => item.id === guideId);
  if (!guide) return;
  openDetails('essential-guidelines', `
    <div class="small text-secondary mb-3">${escapeHtml(guide.description || '')}</div>
    ${guide.results.map((item) => {
      const tone = guidelineStatusTone(item.status);
      const clickable = item.sourceBlockKey ? ' detail-clickable' : '';
      return `
        <div class="detail-card">
          <div class="detail-card-title">
            <span>${escapeHtml(item.label || item.id)}</span>
            <span class="badge text-bg-${tone}">${escapeHtml(guidelineStatusLabel(item.status))}</span>
          </div>
          <div class="small text-secondary mb-2">${escapeHtml(item.requirement || '')}</div>
          <div class="small mb-2">${escapeHtml(item.message || '')}</div>
          ${item.evidenceQuote ? `
            <div class="small text-secondary${clickable}"${detailLinkAttributes(item.sourceBlockKey)}>${escapeHtml(item.evidenceQuote)}</div>
          ` : ''}
        </div>
      `;
    }).join('')}
  `);
}

function detailTitle(kind = '') {
  return {
    abstract: 'Abstract Details',
    article: 'Article Details',
    tables: 'Tables',
    figures: 'Figures',
    references: 'References',
    'essential-guidelines': 'Essential Guidelines'
  }[kind] || 'Details';
}

function openDetails(kind = '', html = '') {
  state.activeDetailKind = kind;
  els.detailsPanelTitle.textContent = detailTitle(kind);
  els.detailsPanelBody.innerHTML = html;
  els.detailsPanel.classList.add('open');
  els.detailsPanel.setAttribute('aria-hidden', 'false');
}

function closeDetails() {
  state.activeDetailKind = '';
  els.detailsPanel.classList.remove('open');
  els.detailsPanel.setAttribute('aria-hidden', 'true');
}

function renderDetailLoading(kind = '') {
  openDetails(kind, `
    ${renderProgressCard({
      title: 'Preparing details',
      message: 'The manuscript is ready. This panel is being assembled from the OCR4 result.',
      progress: null
    })}
  `);
}

function renderDetailError(kind = '', error = '') {
  openDetails(kind, `<div class="alert alert-danger mb-0">${escapeHtml(error || 'Could not load details.')}</div>`);
}

function tableAssetHtml(table = {}) {
  const html = sanitizeMistralHtml(table.html || table.table_html || table.tableHtml || '');
  if (html) return `<div class="table-responsive">${html}</div>`;
  return `<div class="detail-text">${escapeHtml(table.markdown || table.text || table.id || 'Table returned by OCR4.')}</div>`;
}

function tableAssetText(table = {}) {
  return ocrPlainText(table.markdown || table.text || table.html || table.table_html || table.tableHtml || table.id || '');
}

function collectDisplayItems(kind = 'tables') {
  const blockItems = [];
  const assetItems = [];
  const singular = kind === 'tables' ? 'table' : 'figure';
  state.pages.forEach((page, pagePosition) => {
    const number = pageNumber(page, pagePosition);
    const blocks = getBlocks(page);
    blocks.forEach((block, blockIndex) => {
      const type = blockType(block);
      if (kind === 'tables' && type !== 'table') return;
      if (kind === 'figures' && type !== 'image' && type !== 'figure') return;
      const key = `block-${pageIndex(page)}-${blockIndex}`;
      const text = ocrPlainText(blockText(block) || renderBlockContent(block, page));
      blockItems.push({
        itemId: `${singular}-block-${pageIndex(page)}-${blockIndex}`,
        kind: singular,
        key,
        sourceBlockKey: key,
        pageNumber: number,
        label: `${kind === 'tables' ? 'Table' : 'Figure'} on page ${number}`,
        text,
        content: renderBlockContent(block, page)
      });
    });
    if (kind === 'tables') {
      (Array.isArray(page.tables) ? page.tables : []).forEach((table, index) => {
        assetItems.push({
          itemId: `table-asset-${pageIndex(page)}-${index}`,
          kind: 'table',
          key: '',
          sourceBlockKey: '',
          pageNumber: number,
          label: `Table asset ${index + 1} on page ${number}`,
          text: tableAssetText(table),
          content: tableAssetHtml(table)
        });
      });
    }
    if (kind === 'figures') {
      (Array.isArray(page.images) ? page.images : []).forEach((image, index) => {
        const src = imageSource(image);
        assetItems.push({
          key: '',
          itemId: `figure-asset-${pageIndex(page)}-${index}`,
          kind: 'figure',
          sourceBlockKey: '',
          pageNumber: number,
          label: `Figure asset ${index + 1} on page ${number}`,
          text: ocrPlainText(image.alt || image.caption || image.id || image.name || `Figure asset ${index + 1} on page ${number}`),
          content: src ? `<img class="ocr-image" src="${escapeHtml(src)}" alt="OCR figure asset">` : '<div class="detail-text">Figure asset returned by OCR4.</div>'
        });
      });
    }
  });
  const items = blockItems.length ? blockItems : assetItems;
  const seen = new Set();
  return items.filter((item) => {
    const signature = `${item.key}:${item.label}:${item.content.slice(0, 80)}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function collectAllDisplayItems() {
  return [...collectDisplayItems('tables'), ...collectDisplayItems('figures')];
}

function displayResolverRequestItems() {
  return collectAllDisplayItems().map((item, index) => ({
    itemId: item.itemId || `display-${index}`,
    kind: item.kind,
    sourceBlockKey: item.sourceBlockKey || item.key || '',
    pageNumber: item.pageNumber,
    label: item.label,
    text: item.text || ocrPlainText(item.content || '')
  }));
}

function displayResolverReadyItems() {
  if (state.displayResolver.status !== 'ready') return [];
  const sourceById = new Map(collectAllDisplayItems().map((item) => [item.itemId, item]));
  return (Array.isArray(state.displayResolver.result?.items) ? state.displayResolver.result.items : [])
    .filter((item) => item?.isManuscriptItem)
    .map((item, index) => {
      const source = sourceById.get(String(item.itemId || '')) || {};
      const kind = String(item.kind || source.kind || '').toLowerCase();
      return {
        ...source,
        ...item,
        kind,
        label: String(item.label || source.label || `${kind === 'figure' ? 'Figure' : 'Table'} ${index + 1}`),
        key: String(item.sourceBlockKey || source.key || source.sourceBlockKey || ''),
        citationOccurrences: Array.isArray(item.citationOccurrences) ? item.citationOccurrences : []
      };
    })
    .filter((item) => item.kind === 'table' || item.kind === 'figure');
}

function displayResolverExcludedItems(kind = '') {
  if (state.displayResolver.status !== 'ready') return [];
  const targetKind = kind === 'tables' ? 'table' : 'figure';
  return (Array.isArray(state.displayResolver.result?.items) ? state.displayResolver.result.items : [])
    .filter((item) => String(item.kind || '').toLowerCase() === targetKind && !item.isManuscriptItem);
}

function bodyBlocksForDisplayResolver(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  return countBlocksForResolver(blocks, positions).map((block) => ({
    blockKey: block.blockKey,
    pageNumber: block.pageNumber,
    type: block.type,
    text: block.text
  }));
}

async function updateStoredReviewDisplayResolver(result = null) {
  if (!state.currentReview?.id || !result) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.displayResolver = {
      status: 'ready',
      result,
      updatedAt: new Date().toISOString()
    };
    const manuscriptItems = (Array.isArray(result.items) ? result.items : []).filter((item) => item?.isManuscriptItem);
    existing.ocr = {
      ...(existing.ocr || {}),
      semanticCounts: {
        ...(existing.ocr?.semanticCounts || {}),
        tableCount: manuscriptItems.filter((item) => item.kind === 'table').length,
        figureCount: manuscriptItems.filter((item) => item.kind === 'figure').length
      }
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
  } catch (error) {
    console.warn('[deskreview-mistral-2] could not store table/figure resolver result', error);
  }
}

async function updateStoredReviewDisplayFailure(error = '') {
  if (!state.currentReview?.id) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.displayResolver = {
      status: 'failed',
      result: null,
      error: String(error || 'Table/figure details unavailable.'),
      updatedAt: new Date().toISOString()
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((refreshError) => console.warn('[deskreview-mistral-2] library refresh failed', refreshError));
  } catch (storeError) {
    console.warn('[deskreview-mistral-2] could not store table/figure resolver failure', storeError);
  }
}

function renderDisplayResolvingDetail(kind = 'tables') {
  openDetails(kind, renderProgressCard({
    title: `Resolving ${kind}`,
    message: 'The manuscript is ready. Table and figure details are being checked from the OCR result.',
    progress: null
  }));
}

function renderResolvedDisplayDetails(kind = 'tables') {
  const targetKind = kind === 'tables' ? 'table' : 'figure';
  const items = displayResolverReadyItems().filter((item) => item.kind === targetKind);
  const excluded = displayResolverExcludedItems(kind);
  const warnings = cleanUserWarnings(state.displayResolver.result?.warnings || []);
  if (!items.length) {
    openDetails(kind, `
      ${renderWarnings(warnings)}
      <div class="empty-state"><i class="bi ${kind === 'tables' ? 'bi-table' : 'bi-image'}"></i><div>No manuscript ${escapeHtml(kind)} were returned.</div></div>
      ${excluded.length ? `<div class="small text-secondary mt-2">${escapeHtml(excluded.length)} OCR item${excluded.length === 1 ? '' : 's'} excluded as non-manuscript content.</div>` : ''}
    `);
    return;
  }
  openDetails(kind, `
    ${renderWarnings(warnings)}
    ${excluded.length ? `<div class="alert alert-light border small">${escapeHtml(excluded.length)} OCR item${excluded.length === 1 ? '' : 's'} excluded as non-manuscript content.</div>` : ''}
    ${items.map((item, index) => {
      const itemBlockKey = item.key || findBlockKeyForQuote(item.anchorQuote || item.text || item.label || '');
      return `
        <div class="detail-card">
          <div class="detail-card-title">
            <span>${escapeHtml(item.label || `${targetKind === 'table' ? 'Table' : 'Figure'} ${index + 1}`)}</span>
            <span class="badge text-bg-light">${escapeHtml((item.citationOccurrences || []).length)} uses</span>
          </div>
          <div class="${itemBlockKey ? 'detail-clickable' : ''}" ${itemBlockKey ? `data-detail-block-key="${escapeHtml(itemBlockKey)}" tabindex="0" role="button"` : ''}>
            ${targetKind === 'figure' && item.content ? item.content : `
              <div class="d-flex align-items-center gap-3">
                <span class="d-inline-flex align-items-center justify-content-center rounded-circle ${targetKind === 'table' ? 'text-success bg-success-subtle' : 'text-primary bg-primary-subtle'} p-2 flex-shrink-0" aria-hidden="true">
                  <i class="bi ${targetKind === 'table' ? 'bi-table' : 'bi-image'}"></i>
                </span>
                <span class="small">${escapeHtml(item.anchorQuote || item.text || item.label || 'Jump to manuscript location')}</span>
              </div>
            `}
          </div>
          ${(item.citationOccurrences || []).map((occurrence) => {
            const occurrenceBlockKey = occurrence.blockKey || findBlockKeyForQuote(occurrence.contextQuote || occurrence.citationText || '');
            return `
              <div class="border-top py-2">
                <div class="small fw-semibold">${escapeHtml(occurrence.citationText || 'Body reference')}</div>
                <div class="small text-secondary${detailClickableClass(occurrenceBlockKey)}"${detailLinkAttributes(occurrenceBlockKey)}>${escapeHtml(occurrence.contextQuote || '')}</div>
              </div>
            `;
          }).join('') || '<div class="small text-secondary border-top pt-2">No body-text references were returned for this item.</div>'}
        </div>
      `;
    }).join('')}
  `);
}

async function scheduleDisplayResolver(kind = 'tables') {
  if (state.displayResolver.status === 'ready') {
    renderResolvedDisplayDetails(kind);
    return;
  }
  if (state.displayResolver.status === 'running' && state.displayResolverPromise) {
    renderDisplayResolvingDetail(kind);
    await state.displayResolverPromise.catch(() => {});
    if (state.displayResolver.status === 'ready') renderResolvedDisplayDetails(kind);
    return;
  }
  const blocks = flatBlocks();
  const positions = blockPositionMap(blocks);
  const displayItems = displayResolverRequestItems();
  const bodyBlocks = bodyBlocksForDisplayResolver(blocks, positions);
  if (!displayItems.length) {
    state.displayResolver = { status: 'failed', result: null, error: 'No OCR table or figure items were available.', startedAt: 0 };
    renderDetailError(kind, state.displayResolver.error);
    return;
  }
  markRuntime('Table/figure resolver started', { displayItems: displayItems.length, bodyBlocks: bodyBlocks.length });
  state.displayResolver = { status: 'running', result: null, error: '', startedAt: performance.now() };
  renderDisplayResolvingDetail(kind);
  state.displayResolverPromise = resolveDisplayItemsWithCompletion(displayItems, bodyBlocks)
    .then((response) => {
      const result = response.result || {};
      state.displayResolver = { status: 'ready', result, error: '', startedAt: state.displayResolver.startedAt || 0 };
      updateStoredReviewDisplayResolver(result).catch(() => {});
      renderCounts();
      renderResolvedDisplayDetails(kind);
    })
    .catch((error) => {
      state.displayResolver = {
        status: 'failed',
        result: null,
        error: String(error?.message || error || 'Table/figure resolver failed.'),
        startedAt: 0
      };
      updateStoredReviewDisplayFailure(state.displayResolver.error).catch(() => {});
      renderDetailError(kind, state.displayResolver.error);
    })
    .finally(() => {
      state.displayResolverPromise = null;
    });
  await state.displayResolverPromise;
}

async function renderDisplayDetails(kind = 'tables') {
  const items = collectDisplayItems(kind);
  if (!items.length) {
    openDetails(kind, `<div class="empty-state"><i class="bi ${kind === 'tables' ? 'bi-table' : 'bi-image'}"></i><div>No ${escapeHtml(kind)} were returned by OCR4.</div></div>`);
    return;
  }
  if (state.displayResolver.status === 'ready') {
    renderResolvedDisplayDetails(kind);
    return;
  }
  if (state.displayResolver.status === 'failed') {
    renderDetailError(kind, state.displayResolver.error || 'Table/figure details are unavailable.');
    return;
  }
  if (state.loadedFromLibrary) {
    openDetails(kind, `
      <div class="alert alert-light border small mb-0">
        This stored review does not include saved table/figure citation details yet. Run a fresh analysis once and open this panel to save them to the library.
      </div>
    `);
    return;
  }
  await scheduleDisplayResolver(kind);
}

function renderWarnings(warnings = []) {
  const items = cleanUserWarnings(warnings);
  if (!items.length) return '';
  return `<div class="alert alert-warning small">${items.map(escapeHtml).join('<br>')}</div>`;
}

function cleanUserWarnings(warnings = []) {
  const noisyPatterns = [
    /abstract text split across multiple blocks but fully captured/i,
    /article sections identified by titles/i,
    /non-prose elements.*excluded/i,
    /no valid (bibliography|reference|reference-list)? ?(entries|entry|text)? found/i,
    /no complete bibliography entries/i,
    /entry \d+.*incomplete/i,
    /no text-based references found/i,
    /provided (blocks|text)/i,
    /typographical error/i,
    /\b(block-\d+-\d+|OCR block|internal key|chunk)\b/i
  ];
  return [...new Set((Array.isArray(warnings) ? warnings : [])
    .map((warning) => String(warning || '').trim())
    .filter(Boolean)
    .filter((warning) => !noisyPatterns.some((pattern) => pattern.test(warning))))];
}

function renderCountResolvingDetail(kind = 'abstract', detail = {}) {
  const label = kind === 'article' ? 'article text' : 'abstract text';
  const elapsed = Number(detail.elapsedMs || 0);
  const estimate = 18000;
  return `
    ${renderProgressCard({
      title: 'Resolving counted text',
      message: `The manuscript is ready. The ${label} is being resolved from the OCR result.`,
      progress: boundedProgress(elapsed, estimate),
      eta: elapsed > estimate ? `working for ${formatDuration(elapsed)}` : elapsed ? formatEta(Math.max(0, estimate - elapsed)) : 'about 20 sec left'
    })}
  `;
}

function renderExcludedText(excludedText = []) {
  const items = Array.isArray(excludedText)
    ? excludedText.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!items.length) return '';
  return `
    <details class="detail-card">
      <summary class="detail-card-title mb-0">
        <span>Excluded</span>
        <span class="badge text-bg-light">${escapeHtml(metricValue(items.length))}</span>
      </summary>
      <div class="mt-2 d-grid gap-2">
        ${items.map((item) => `<div class="small text-secondary">${escapeHtml(item)}</div>`).join('')}
      </div>
    </details>
  `;
}

function normalizeForLookup(value = '') {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function quoteCandidates(value = '') {
  const text = String(value || '').trim();
  const pieces = [
    text,
    ...text.split(/\n+/),
    ...text.split(/(?<=[.!?])\s+/)
  ];
  return [...new Set(pieces.map(normalizeForLookup))]
    .filter((candidate) => candidate.length >= 24)
    .sort((a, b) => b.length - a.length)
    .map((candidate) => candidate.length > 220 ? candidate.slice(0, 220) : candidate);
}

function findBlockKeyForQuote(value = '') {
  const candidates = quoteCandidates(value);
  if (!candidates.length) return '';
  for (const candidate of candidates) {
    for (const [key, target] of state.blockTargets.entries()) {
      const normalizedBlock = normalizeForLookup(target.text || '');
      if (normalizedBlock.includes(candidate) || candidate.includes(normalizedBlock)) return key;
    }
  }
  return '';
}

function ocrPlainText(value = '') {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(value = '') {
  return (String(value || '').match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length;
}

function flatBlocks() {
  return state.pages.flatMap((page, pagePosition) => getBlocks(page).map((block, blockIndex) => {
    const key = `block-${pageIndex(page)}-${blockIndex}`;
    return {
      key,
      pageNumber: pageNumber(page, pagePosition),
      pageIndex: pageIndex(page),
      blockIndex,
      type: blockType(block),
      text: blockText(block),
      plainText: ocrPlainText(blockText(block))
    };
  }));
}

function blockPositionMap(blocks = flatBlocks()) {
  return new Map(blocks.map((block, index) => [block.key, index]));
}

function tocEntryIndex(entry = {}, positions = blockPositionMap()) {
  return positions.get(entry.blockKey) ?? -1;
}

function nextTocBoundary(entryIndex = 0, positions = blockPositionMap()) {
  const current = state.tocEntries[entryIndex];
  if (!current) return Number.POSITIVE_INFINITY;
  const currentNumber = String(current.label || '').match(/^(\d+)(?:\.|\s)/)?.[1] || '';
  for (let index = entryIndex + 1; index < state.tocEntries.length; index += 1) {
    const entry = state.tocEntries[index];
    const entryNumber = String(entry.label || '').match(/^(\d+)(?:\.|\s)/)?.[1] || '';
    if (currentNumber && entryNumber && entryNumber !== currentNumber) return tocEntryIndex(entry, positions);
    if (entry.level <= current.level) return tocEntryIndex(entry, positions);
  }
  return Number.POSITIVE_INFINITY;
}

function sectionTextFromToc(entryIndex = 0, blocks = flatBlocks(), positions = blockPositionMap()) {
  const start = tocEntryIndex(state.tocEntries[entryIndex], positions);
  if (start < 0) return '';
  const end = nextTocBoundary(entryIndex, positions);
  return blocks
    .slice(start, Number.isFinite(end) ? end : blocks.length)
    .filter((block) => block.type !== 'table' && block.type !== 'image' && block.type !== 'figure')
    .map((block, index) => {
      if (index > 0) return block.plainText;
      return block.plainText.replace(new RegExp(`^${escapeRegExp(state.tocEntries[entryIndex]?.label || '')}\\s*`, 'i'), '').trim();
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findTocIndex(pattern) {
  return state.tocEntries.findIndex((entry) => pattern.test(entry.label));
}

function headingLikeText(value = '') {
  return ocrPlainText(value)
    .replace(/^\d+\s+/, '')
    .replace(/[:.]\s*$/, '')
    .trim();
}

function findBlockHeadingIndex(blocks = flatBlocks(), pattern) {
  return blocks.findIndex((block) => pattern.test(headingLikeText(block.plainText || block.text || '')));
}

function resolvedHeadingBlockIndex(blocks = flatBlocks(), positions = blockPositionMap(blocks), tocPattern, blockPattern = tocPattern) {
  const tocIndex = findTocIndex(tocPattern);
  if (tocIndex >= 0) {
    const index = tocEntryIndex(state.tocEntries[tocIndex], positions);
    if (index >= 0) return index;
  }
  return findBlockHeadingIndex(blocks, blockPattern);
}

function buildAbstractDetailFromOcr(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  if (state.countResolver.result) return buildCountsDetailsFromResolvedMap(state.countResolver.result, blocks).abstract;
  return buildCountsPendingDetail('abstract');
}

function buildCountsPendingDetail(kind = 'abstract') {
  const elapsed = state.countResolver.startedAt ? performance.now() - state.countResolver.startedAt : 0;
  return {
    kind,
    detail: {
      count: null,
      pending: true,
      elapsedMs: elapsed,
      warnings: ['Resolving counted text from the OCR result.']
    }
  };
}

function blockTextByKey(blocks = flatBlocks()) {
  return new Map(blocks.map((block) => [block.key, block.plainText || ocrPlainText(block.text || '')]));
}

function normalizeMetadataItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      text: String(item?.text || '').trim(),
      sourceBlockKeys: Array.isArray(item?.sourceBlockKeys) ? item.sourceBlockKeys.map(String).filter(Boolean) : []
    }))
    .filter((item) => item.text);
}

function buildMetadataDetail(kind = '', label = '', items = [], warnings = [], available = true) {
  return {
    kind,
    detail: {
      count: available ? items.length : null,
      label,
      items: available ? items : [],
      warnings: available ? warnings : ['This stored review does not include this count yet.']
    }
  };
}

function buildCountsDetailsFromResolvedMap(result = {}, blocks = flatBlocks()) {
  const textByKey = blockTextByKey(blocks);
  const abstractText = String(result.abstract?.countedText || '').trim();
  const metadata = result.metadata || {};
  const metadataAvailable = Boolean(result.metadata)
    && Array.isArray(metadata.authors)
    && Array.isArray(metadata.affiliations)
    && Array.isArray(metadata.keywords);
  const metadataWarnings = [
    ...(Array.isArray(metadata.warnings) ? metadata.warnings : []),
    ...(Array.isArray(result.warnings) ? result.warnings : [])
  ];
  const authors = normalizeMetadataItems(metadata.authors);
  const affiliations = normalizeMetadataItems(metadata.affiliations);
  const keywords = normalizeMetadataItems(metadata.keywords);
  const articleSections = (Array.isArray(result.article?.sections) ? result.article.sections : [])
    .map((section, index) => {
      const sourceKeys = Array.isArray(section.sourceBlockKeys) ? section.sourceBlockKeys.map(String).filter(Boolean) : [];
      const selectedText = sourceKeys
        .map((key) => textByKey.get(key) || '')
        .filter(Boolean)
        .join('\n\n')
        .trim();
      const countedText = String(section.countedText || selectedText || '').trim();
      return {
        title: String(section.title || `Section ${index + 1}`).trim(),
        sourceBlockKeys: sourceKeys,
        countedText,
        count: countWords(countedText)
      };
    })
    .filter((section) => section.countedText);
  return {
    abstract: {
      kind: 'abstract',
      detail: {
        count: countWords(abstractText),
        countedText: abstractText,
        excludedText: Array.isArray(result.abstract?.excludedText) ? result.abstract.excludedText : [],
        warnings: [
          ...(Array.isArray(result.abstract?.warnings) ? result.abstract.warnings : []),
          ...(Array.isArray(result.warnings) ? result.warnings : [])
        ]
      }
    },
    article: {
      kind: 'article',
      detail: {
        count: articleSections.reduce((sum, section) => sum + section.count, 0),
        sections: articleSections,
        excludedText: Array.isArray(result.article?.excludedText) ? result.article.excludedText : [],
        warnings: [
          ...(Array.isArray(result.article?.warnings) ? result.article.warnings : []),
          ...(Array.isArray(result.warnings) ? result.warnings : [])
        ]
      }
    },
    authors: buildMetadataDetail('authors', 'Authors', authors, metadataWarnings, metadataAvailable),
    affiliations: buildMetadataDetail('affiliations', 'Affiliations', affiliations, metadataWarnings, metadataAvailable),
    keywords: buildMetadataDetail('keywords', 'Keywords', keywords, metadataWarnings, metadataAvailable)
  };
}

function countBlocksForResolver(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  const referenceIndex = resolvedHeadingBlockIndex(blocks, positions, /^(references|bibliography)\b/i, /^(references|bibliography|literature cited)\b/i);
  const supplementaryIndex = resolvedHeadingBlockIndex(blocks, positions, /^(supplementary|supplemental|appendix)\b/i);
  const referenceStart = referenceIndex >= 0 ? referenceIndex : blocks.length;
  const supplementaryStart = supplementaryIndex >= 0 ? supplementaryIndex : blocks.length;
  const end = Math.min(referenceStart, supplementaryStart, blocks.length);
  return blocks
    .slice(0, end)
    .filter((block) => block.type !== 'table' && block.type !== 'image' && block.type !== 'figure')
    .map((block) => ({
      blockKey: block.key,
      pageNumber: block.pageNumber,
      type: block.type,
      text: block.text || block.plainText
    }))
    .filter((block) => block.text);
}

async function updateStoredReviewCountResolver(result = null) {
  if (!state.currentReview?.id || !result) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    const details = buildCountsDetailsFromResolvedMap(result, flatBlocks());
    existing.countResolver = {
      status: 'ready',
      result,
      updatedAt: new Date().toISOString()
    };
    existing.ocr = {
      ...(existing.ocr || {}),
      semanticCounts: {
        ...(existing.ocr?.semanticCounts || {}),
        abstractWordCount: details.abstract.detail.count,
        articleWordCount: details.article.detail.count,
        authorCount: details.authors.detail.count,
        affiliationCount: details.affiliations.detail.count,
        keywordCount: details.keywords.detail.count
      }
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
  } catch (error) {
    console.warn('[deskreview-mistral-2] could not store counted-text resolver result', error);
  }
}

async function updateStoredReviewCountResolverFailure(error = '') {
  if (!state.currentReview?.id) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.countResolver = {
      status: 'failed',
      result: null,
      error: String(error || 'Count resolver unavailable.'),
      updatedAt: new Date().toISOString()
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((refreshError) => console.warn('[deskreview-mistral-2] library refresh failed', refreshError));
  } catch (storeError) {
    console.warn('[deskreview-mistral-2] could not store counted-text resolver failure', storeError);
  }
}

async function scheduleCountResolver(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  if (state.countResolver.status === 'ready' || state.countResolver.status === 'running') return;
  const resolverBlocks = countBlocksForResolver(blocks, positions);
  if (!resolverBlocks.length) {
    state.countResolver = { status: 'failed', result: null, error: 'No OCR text blocks were available for counted-text resolution.' };
    markRuntime('Word-count resolver skipped', { reason: 'no OCR text blocks' });
    updateStoredReviewCountResolverFailure(state.countResolver.error).catch(() => {});
    prepareReferenceDetails(blocks, positions);
    return;
  }
  markRuntime('Word-count resolver started', { blocks: resolverBlocks.length });
  state.countResolver = { status: 'running', result: null, error: '', startedAt: performance.now() };
  ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
    state.detailCache.set(kind, buildCountsPendingDetail(kind));
    state.detailBuildStatus.set(kind, 'pending');
  });
  renderCounts();
  updateBackgroundStatus();
  startProgressTicker();
  ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
    if (state.activeDetailKind === kind) renderSemanticDetail(kind, state.detailCache.get(kind));
  });
  try {
    const response = await resolveCountsWithCompletion(resolverBlocks);
    const result = response.result || {};
    state.countResolver = { status: 'ready', result, error: '', startedAt: state.countResolver.startedAt || 0 };
    const details = buildCountsDetailsFromResolvedMap(result, blocks);
    state.detailCache.set('abstract', details.abstract);
    state.detailCache.set('article', details.article);
    state.detailCache.set('authors', details.authors);
    state.detailCache.set('affiliations', details.affiliations);
    state.detailCache.set('keywords', details.keywords);
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => state.detailBuildStatus.set(kind, 'ready'));
    state.semanticCounts = {
      ...(state.semanticCounts || {}),
      abstractWordCount: details.abstract.detail.count,
      articleWordCount: details.article.detail.count,
      authorCount: details.authors.detail.count,
      affiliationCount: details.affiliations.detail.count,
      keywordCount: details.keywords.detail.count
    };
    markRuntime('Word-count tiles ready', {
      abstractWords: details.abstract.detail.count,
      articleWords: details.article.detail.count,
      authors: details.authors.detail.count,
      affiliations: details.affiliations.detail.count,
      keywords: details.keywords.detail.count
    });
    renderCounts();
    updateStoredReviewCountResolver(result).catch(() => {});
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
      if (state.activeDetailKind === kind) renderSemanticDetail(kind, details[kind]);
    });
    updateBackgroundStatus();
    prepareReferenceDetails(blocks, positions);
    if (state.referenceResolver.status !== 'running') stopProgressTicker();
  } catch (error) {
    state.countResolver = { status: 'failed', result: null, error: String(error?.message || error || 'Counted-text resolver failed.'), startedAt: 0 };
    markRuntime('Word-count resolver failed', { error: state.countResolver.error });
    updateStoredReviewCountResolverFailure(state.countResolver.error).catch(() => {});
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
      state.detailBuildStatus.set(kind, 'failed');
      state.detailCache.set(kind, {
        kind,
        detail: { count: 0, pending: false, warnings: [state.countResolver.error] }
      });
    });
    renderCounts();
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
      if (state.activeDetailKind === kind) renderSemanticDetail(kind, state.detailCache.get(kind));
    });
    updateBackgroundStatus();
    prepareReferenceDetails(blocks, positions);
    if (state.referenceResolver.status !== 'running') stopProgressTicker();
  }
}

function buildArticleDetailFromOcr(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  if (state.countResolver.result) return buildCountsDetailsFromResolvedMap(state.countResolver.result, blocks).article;
  return buildCountsPendingDetail('article');
}

function contextAround(text = '', index = 0, length = 1) {
  const start = Math.max(0, index - 150);
  const end = Math.min(text.length, index + length + 150);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function bodyTextWithBlockOffsets(bodyBlocks = []) {
  let text = '';
  const ranges = [];
  bodyBlocks.forEach((block) => {
    const start = text.length;
    const blockTextValue = block.plainText || '';
    text += `${blockTextValue}\n\n`;
    ranges.push({ key: block.key, start, end: start + blockTextValue.length });
  });
  return { text, ranges };
}

function blockKeyAtOffset(offset = 0, ranges = []) {
  return ranges.find((range) => offset >= range.start && offset <= range.end)?.key || '';
}

function matcherPattern(matcher = '') {
  const trimmed = String(matcher || '').trim();
  if (!trimmed || trimmed.length < 2) return null;
  return new RegExp(escapeRegExp(trimmed).replace(/\s+/g, '\\s+'), 'gi');
}

function findCitationOccurrencesFromMatchers(matchers = [], bodyBlocks = []) {
  const { text, ranges } = bodyTextWithBlockOffsets(bodyBlocks);
  const seen = new Set();
  const occurrences = [];
  matchers
    .map(matcherPattern)
    .filter(Boolean)
    .forEach((pattern) => {
      for (const match of text.matchAll(pattern)) {
        const offset = match.index || 0;
        const contextQuote = contextAround(text, offset, match[0].length);
        const signature = `${match[0]}:${contextQuote}`;
        if (!contextQuote || seen.has(signature)) continue;
        seen.add(signature);
        occurrences.push({
          citationText: match[0],
          contextQuote,
          blockKey: blockKeyAtOffset(offset, ranges)
        });
        if (occurrences.length >= 12) break;
      }
    });
  return occurrences;
}

function findCitationOccurrencesFromPatterns(patterns = [], bodyBlocks = []) {
  const { text, ranges } = bodyTextWithBlockOffsets(bodyBlocks);
  const seen = new Set();
  const occurrences = [];
  patterns.forEach((pattern) => {
    for (const match of text.matchAll(pattern)) {
      const offset = match.index || 0;
      const contextQuote = contextAround(text, offset, match[0].length);
      const signature = `${match[0]}:${contextQuote}`;
      if (!contextQuote || seen.has(signature)) continue;
      seen.add(signature);
      occurrences.push({
        citationText: match[0],
        contextQuote,
        blockKey: blockKeyAtOffset(offset, ranges)
      });
      if (occurrences.length >= 12) break;
    }
  });
  return occurrences;
}

function findCitationOccurrencesFromPatternSpecs(specs = [], bodyBlocks = []) {
  const { text, ranges } = bodyTextWithBlockOffsets(bodyBlocks);
  const seen = new Set();
  const occurrences = [];
  specs.forEach((spec) => {
    const pattern = spec?.pattern;
    if (!(pattern instanceof RegExp)) return;
    for (const match of text.matchAll(pattern)) {
      if (typeof spec.accept === 'function' && !spec.accept(match)) continue;
      const offset = match.index || 0;
      const contextQuote = contextAround(text, offset, match[0].length);
      const signature = `${match[0]}:${contextQuote}`;
      if (!contextQuote || seen.has(signature)) continue;
      seen.add(signature);
      occurrences.push({
        citationText: match[0],
        contextQuote,
        blockKey: blockKeyAtOffset(offset, ranges)
      });
      if (occurrences.length >= 12) break;
    }
  });
  return occurrences;
}

function normalizeCitationDigits(value = '') {
  const map = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  return String(value || '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (digit) => map[digit] || digit);
}

function numericCitationGroupIncludes(value = '', number = 0) {
  const target = Number(number || 0);
  if (!Number.isFinite(target) || target <= 0) return false;
  const normalized = normalizeCitationDigits(value)
    .replace(/[–—]/g, '-')
    .replace(/\bto\b/gi, '-');
  const pattern = /(\d+)\s*-\s*(\d+)|\d+/g;
  for (const match of normalized.matchAll(pattern)) {
    if (match[1] && match[2]) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && target >= Math.min(start, end) && target <= Math.max(start, end)) return true;
      continue;
    }
    if (Number(match[0]) === target) return true;
  }
  return false;
}

function numericCitationStyle(bodyBlocks = []) {
  const text = bodyBlocks.map((block) => block.plainText || '').join('\n\n');
  const latexSuperscripts = (text.match(/\$\^\{\s*\d+(?:\s*[-,]\s*\d+)*\s*}\$/g) || []).length
    + (text.match(/\$\^\s*\d+(?:\s*[-,]\s*\d+)*\s*\$/g) || []).length
    + (text.match(/\^\{\s*\d+(?:\s*[-,]\s*\d+)*\s*}/g) || []).length
    + (text.match(/(?<!\$)\^\s*\d+(?:\s*[-,]\s*\d+)*/g) || []).length;
  const unicodeSuperscripts = (text.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g) || []).length;
  const bracketed = (text.match(/\[\s*\d+(?:\s*[-,]\s*\d+)*\s*]/g) || []).length;
  const parenthesized = (text.match(/\(\s*\d+(?:\s*[-,]\s*\d+)*\s*\)/g) || []).length;
  if (latexSuperscripts + unicodeSuperscripts > bracketed + parenthesized) return 'superscript';
  if (bracketed >= parenthesized && bracketed > 0) return 'bracket';
  if (parenthesized > 0) return 'paren';
  return 'mixed';
}

function findNumericCitationOccurrences(number = 0, bodyBlocks = []) {
  const style = numericCitationStyle(bodyBlocks);
  const acceptsNumber = (match, groupIndex = 1) => numericCitationGroupIncludes(match[groupIndex] || match[0] || '', number);
  const specs = [
    { pattern: /\$\^\{([^}]*)\}\$/gu, accept: (match) => acceptsNumber(match, 1) },
    { pattern: /\$\^\s*([0-9,\s\-–—]+)\s*\$/gu, accept: (match) => acceptsNumber(match, 1) },
    { pattern: /(?<!\$)\^\{([^}]*)\}/gu, accept: (match) => acceptsNumber(match, 1) },
    { pattern: /(?<!\$)\^\s*([0-9,\s\-–—]+)/gu, accept: (match) => acceptsNumber(match, 1) },
    { pattern: /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu, accept: (match) => acceptsNumber(match, 0) }
  ];
  if (style !== 'superscript') {
    specs.push(
      { pattern: /\[\s*([0-9,\s\-–—]+)\s*\]/gu, accept: (match) => acceptsNumber(match, 1) },
      { pattern: /\(\s*([0-9,\s\-–—]+)\s*\)/gu, accept: (match) => acceptsNumber(match, 1) }
    );
  }
  if (style === 'mixed') {
    const escaped = escapeRegExp(String(number));
    specs.push({ pattern: new RegExp(`(?<=[\\p{L}\\)])${escaped}(?!\\d)`, 'gu') });
  }
  return findCitationOccurrencesFromPatternSpecs(specs, bodyBlocks);
}

function stopReferenceBlocksAtSupplement(referenceBlocks = []) {
  const stopPattern = /(^|\n)\s*(take home message|illustration|authorship|supplementary|supplemental|appendix|section\s+\d+|table\s+s?\d+|figure\s+s?\d+)/i;
  const items = [];
  for (const block of referenceBlocks) {
    const text = block.text || block.plainText || '';
    const match = text.match(stopPattern);
    if (match && items.length) {
      const cropped = text.slice(0, match.index).trim();
      if (cropped) items.push({ ...block, text: cropped, plainText: ocrPlainText(cropped) });
      break;
    }
    items.push(block);
  }
  return items;
}

function isOcrReferenceBlock(block = {}) {
  return /^(references?|bibliography|reference_list|reference-list)$/i.test(String(block.type || '').trim());
}

function ocrReferenceTypedStartIndex(blocks = []) {
  return blocks.findIndex((block) => isOcrReferenceBlock(block));
}

function ocrReferenceTypedBlocks(blocks = [], startIndex = -1) {
  if (startIndex < 0) return [];
  const items = [];
  for (let index = startIndex; index < blocks.length; index += 1) {
    const block = blocks[index];
    const type = String(block?.type || '').trim().toLowerCase();
    if (isOcrReferenceBlock(block) || (items.length && type === 'list')) {
      items.push(block);
      continue;
    }
    if (items.length && type === 'footer') continue;
    if (items.length) break;
  }
  return items;
}

function trailingReferenceContextBlocks(blocks = [], maxBlocks = 48, maxChars = 42000) {
  const selected = [];
  let totalChars = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block || block.type === 'table' || block.type === 'image' || block.type === 'figure') continue;
    const text = String(block.text || block.plainText || '').trim();
    if (!text) continue;
    selected.unshift(block);
    totalChars += text.length;
    if (selected.length >= maxBlocks || totalChars >= maxChars) break;
  }
  return selected;
}

function collectReferenceContext(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  const referencesIndex = findTocIndex(/^(references|bibliography)\b/i);
  const referenceStart = resolvedHeadingBlockIndex(blocks, positions, /^(references|bibliography)\b/i, /^(references|bibliography|literature cited)\b/i);
  const introductionIndex = resolvedHeadingBlockIndex(blocks, positions, /^(introduction|background)\b/i);
  const abstractIndex = resolvedHeadingBlockIndex(blocks, positions, /^abstract\b/i);
  const bodyStart = introductionIndex >= 0
    ? introductionIndex
    : (abstractIndex >= 0 ? abstractIndex + 1 : 0);
  const ocrReferenceStart = referenceStart >= 0 ? -1 : ocrReferenceTypedStartIndex(blocks);
  const inferred = referenceStart < 0;
  const rawReferenceBlocks = referenceStart >= 0
    ? blocks.slice(referenceStart)
    : (ocrReferenceStart >= 0 ? ocrReferenceTypedBlocks(blocks, ocrReferenceStart) : trailingReferenceContextBlocks(blocks));
  const referenceBlocks = stopReferenceBlocksAtSupplement(rawReferenceBlocks);
  const inferredStart = referenceStart >= 0 ? referenceStart : ocrReferenceStart;
  const bodyBlocks = inferredStart >= 0 ? blocks.slice(Math.max(0, bodyStart), inferredStart) : blocks.slice(Math.max(0, bodyStart));
  return {
    referencesIndex,
    referenceStart,
    ocrReferenceStart,
    bodyStart,
    inferred,
    inferredFromOcrBlockType: referenceStart < 0 && ocrReferenceStart >= 0,
    referenceBlocks,
    bodyBlocks
  };
}

function bodyBlocksForResolvedReferences(result = {}, blocks = flatBlocks(), context = collectReferenceContext(blocks, blockPositionMap(blocks))) {
  if (!context.inferred || context.referenceStart >= 0 || context.ocrReferenceStart >= 0) return context.bodyBlocks;
  const positions = blockPositionMap(blocks);
  const sourceIndexes = (Array.isArray(result.entries) ? result.entries : [])
    .map((entry) => positions.get(String(entry.sourceBlockKey || '')))
    .filter((index) => Number.isFinite(index) && index >= 0);
  const inferredStart = sourceIndexes.length ? Math.min(...sourceIndexes) : blocks.length;
  return blocks.slice(Math.max(0, context.bodyStart || 0), inferredStart);
}

function referenceBlocksForResolver(referenceBlocks = []) {
  return referenceBlocks
    .filter((block) => block.text || block.plainText)
    .map((block) => ({
      blockKey: block.key,
      pageNumber: block.pageNumber,
      text: String(block.text || block.plainText || '').trim()
    }));
}

function chunkReferenceBlocks(blocks = [], maxChars = 5200, overlapLines = 20) {
  const chunks = [];
  blocks.forEach((block) => {
    const lines = String(block.text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let current = [];
    let currentLength = 0;
    const flush = () => {
      if (!current.length) return;
      chunks.push({
        blockKey: block.blockKey,
        pageNumber: block.pageNumber,
        text: current.join('\n')
      });
      current = current.slice(-overlapLines);
      currentLength = current.reduce((sum, line) => sum + line.length + 1, 0);
    };
    lines.forEach((line) => {
      const nextLength = currentLength + line.length + 1;
      if (current.length && nextLength > maxChars) flush();
      current.push(line);
      currentLength += line.length + 1;
    });
    flush();
  });
  return chunks.length ? chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index + 1, totalChunks: chunks.length })) : blocks;
}

function batchReferenceChunks(chunks = [], maxChars = 10000, maxBlocks = 6) {
  const batches = [];
  let current = [];
  let currentLength = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    currentLength = 0;
  };
  chunks.forEach((chunk) => {
    const length = String(chunk.text || '').length;
    if (current.length && (current.length >= maxBlocks || currentLength + length > maxChars)) flush();
    current.push(chunk);
    currentLength += length;
  });
  flush();
  return batches;
}

function referenceSignature(text = '') {
  return normalizeForLookup(text).slice(0, 220);
}

function mergeResolvedReferenceChunks(results = []) {
  const warnings = [];
  const seen = new Set();
  const entries = [];
  results.forEach((result) => {
    (Array.isArray(result?.warnings) ? result.warnings : []).forEach((warning) => {
      if (warning) warnings.push(warning);
    });
    (Array.isArray(result?.entries) ? result.entries : []).forEach((entry) => {
      const rawReferenceText = String(entry.rawReferenceText || '').trim();
      const signature = referenceSignature(rawReferenceText);
      if (!rawReferenceText || seen.has(signature)) return;
      seen.add(signature);
      entries.push({
        ...entry,
        number: entries.length + 1,
        rawReferenceText
      });
    });
  });
  return {
    entries,
    warnings: cleanUserWarnings(warnings)
      .filter((warning) => !/no valid bibliography entries|incomplete|truncated|fragment/i.test(String(warning || '')))
  };
}

function buildReferencesDetailFromResolvedMap(resolved = {}, bodyBlocks = []) {
  const warnings = cleanUserWarnings(resolved.warnings);
  const entries = (Array.isArray(resolved.entries) ? resolved.entries : [])
    .map((entry, index) => {
      const matchers = Array.isArray(entry.citationMatchers) ? entry.citationMatchers : [];
      let citationOccurrences = findCitationOccurrencesFromMatchers(matchers, bodyBlocks);
      if (!citationOccurrences.length) {
        const number = Number(entry.number || index + 1);
        citationOccurrences = findNumericCitationOccurrences(number, bodyBlocks);
      }
      return {
        number: Number(entry.number || index + 1),
        rawText: String(entry.rawReferenceText || '').trim(),
        sourceBlockKey: String(entry.sourceBlockKey || ''),
        bibliographyAnchorQuote: String(entry.bibliographyAnchorQuote || '').trim(),
        citationMatchers: matchers,
        citationOccurrences
      };
    })
    .filter((entry) => entry.rawText);
  return {
    kind: 'references',
    detail: {
      count: entries.length,
      entries,
      warnings
    }
  };
}

function buildReferencesPendingDetail(message = 'Resolving references from the OCR text.') {
  const completed = Number(state.referenceResolver.completed || 0);
  const total = Number(state.referenceResolver.total || 0);
  const progress = total > 1 ? ` ${completed} of ${total} parts complete.` : '';
  const elapsed = state.referenceResolver.startedAt ? performance.now() - state.referenceResolver.startedAt : 0;
  const eta = completed > 0 && total > completed
    ? ((elapsed / completed) * (total - completed))
    : null;
  return {
    kind: 'references',
    detail: {
      count: Number(state.semanticCounts?.referenceCount || 0),
      entries: [],
      pending: true,
      progressPercent: total ? Math.round((completed / total) * 100) : null,
      etaMs: eta,
      warnings: [`${message}${progress}`.trim()]
    }
  };
}

async function updateStoredReviewReferenceMap(result = null) {
  if (!state.currentReview?.id || !result) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.referenceResolver = {
      status: 'ready',
      result,
      updatedAt: new Date().toISOString()
    };
    existing.ocr = {
      ...(existing.ocr || {}),
      semanticCounts: {
        ...(existing.ocr?.semanticCounts || {}),
        referenceCount: Array.isArray(result.entries) ? result.entries.length : existing.ocr?.semanticCounts?.referenceCount
      }
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
  } catch (error) {
    console.warn('[deskreview-mistral-2] could not store reference resolver result', error);
  }
}

async function updateStoredReviewReferenceFailure(error = '') {
  if (!state.currentReview?.id) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.referenceResolver = {
      status: 'failed',
      result: null,
      error: String(error || 'Reference resolver unavailable.'),
      updatedAt: new Date().toISOString()
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((refreshError) => console.warn('[deskreview-mistral-2] library refresh failed', refreshError));
  } catch (storeError) {
    console.warn('[deskreview-mistral-2] could not store reference resolver failure', storeError);
  }
}

async function updateStoredReviewSemanticCounts(partialCounts = {}) {
  if (!state.currentReview?.id) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.ocr = {
      ...(existing.ocr || {}),
      semanticCounts: {
        ...(existing.ocr?.semanticCounts || {}),
        ...partialCounts
      }
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
  } catch (error) {
    console.warn('[deskreview-mistral-2] could not store corrected counts', error);
  }
}

async function updateStoredReviewDocumentAnnotation(result = null) {
  if (!state.currentReview?.id || !result) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.documentAnnotation = {
      status: 'ready',
      result,
      updatedAt: new Date().toISOString()
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
  } catch (error) {
    console.warn('[deskreview-mistral-2] could not store document annotation', error);
  }
}

async function updateStoredReviewDocumentAnnotationFailure(error = '') {
  if (!state.currentReview?.id) return;
  try {
    const existing = await getStoredReview(state.currentReview.id);
    if (!existing) return;
    existing.documentAnnotation = {
      status: 'failed',
      result: null,
      error: String(error || 'Document annotation unavailable.'),
      updatedAt: new Date().toISOString()
    };
    existing.updatedAt = new Date().toISOString();
    await putStoredReview(existing);
    state.currentReview = existing;
    refreshLibrary().catch((refreshError) => console.warn('[deskreview-mistral-2] library refresh failed', refreshError));
  } catch (storeError) {
    console.warn('[deskreview-mistral-2] could not store document annotation failure', storeError);
  }
}

function scheduleDocumentAnnotation(blocks = flatBlocks()) {
  if (state.loadedFromLibrary) return;
  if (state.documentAnnotation.status === 'ready' || state.documentAnnotation.status === 'running') return;
  const payload = buildDocumentAnnotationRequest({
    blocks,
    countResolver: state.countResolver,
    referenceResolver: state.referenceResolver,
    displayResolver: state.displayResolver
  });
  if (!payload.blocks.length) {
    state.documentAnnotation = { status: 'failed', result: null, error: 'No OCR blocks were available for document annotation.', startedAt: 0 };
    renderEssentialGuidelines();
    return;
  }
  markRuntime('Document annotation started', { blocks: payload.blocks.length });
  state.documentAnnotation = { status: 'running', result: null, error: '', startedAt: performance.now() };
  state.documentAnnotationPromise = annotateDocumentWithCompletion(payload)
    .then((response) => {
      const result = normalizeDocumentAnnotation(response.result || {});
      state.documentAnnotation = { status: 'ready', result, error: '', startedAt: state.documentAnnotation.startedAt || 0 };
      markRuntime('Document annotation ready', {
        quoteAnchors: result.quoteAnchors.length,
        warnings: result.warnings.length
      });
      renderEssentialGuidelines();
      updateStoredReviewDocumentAnnotation(result).catch(() => {});
    })
    .catch((error) => {
      state.documentAnnotation = {
        status: 'failed',
        result: null,
        error: String(error?.message || error || 'Document annotation failed.'),
        startedAt: 0
      };
      markRuntime('Document annotation failed', { error: state.documentAnnotation.error });
      renderEssentialGuidelines();
      updateStoredReviewDocumentAnnotationFailure(state.documentAnnotation.error).catch(() => {});
    })
    .finally(() => {
      state.documentAnnotationPromise = null;
    });
}

async function scheduleReferenceResolver(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  if (state.referenceResolver.status === 'ready' || state.referenceResolver.status === 'running') return;
  const referenceContext = collectReferenceContext(blocks, positions);
  const { referenceBlocks } = referenceContext;
  const inferBibliographyRegion = referenceContext.inferred && !referenceContext.inferredFromOcrBlockType;
  const resolverBlocks = referenceBlocksForResolver(referenceBlocks);
  if (!resolverBlocks.length) {
    state.referenceResolver = { status: 'failed', result: null, error: 'The reference list could not be located in the OCR result.', completed: 0, total: 0, startedAt: 0 };
    state.detailCache.set('references', buildReferencesPendingDetail('The reference list could not be located in the OCR result.'));
    markRuntime('Reference resolver skipped', { reason: 'no reference-list OCR blocks' });
    updateStoredReviewReferenceFailure(state.referenceResolver.error).catch(() => {});
    return;
  }
  const splitChunks = chunkReferenceBlocks(resolverBlocks);
  const chunks = splitChunks.length > 12
    ? splitChunks.map((chunk) => [chunk])
    : batchReferenceChunks(splitChunks);
  markRuntime('Reference resolver started', {
    blocks: resolverBlocks.length,
    batches: chunks.length,
    inferredRegion: inferBibliographyRegion,
    ocrReferenceBlocks: referenceContext.inferredFromOcrBlockType
  });
  state.referenceResolver = { status: 'running', result: null, error: '', completed: 0, total: chunks.length, startedAt: performance.now() };
  state.detailCache.set('references', buildReferencesPendingDetail(
    referenceContext.inferred
      ? 'Resolving references without an explicit References heading.'
      : 'Resolving references from the OCR text.'
  ));
  renderCounts();
  updateBackgroundStatus();
  startProgressTicker();
  if (state.activeDetailKind === 'references') renderSemanticDetail('references', state.detailCache.get('references'));
  try {
    const results = new Array(chunks.length);
    await Promise.all(chunks.map(async (chunk, index) => {
      results[index] = await resolveReferenceBatchWithFallback(chunk, index, { inferBibliographyRegion });
      state.referenceResolver.completed += 1;
      state.detailCache.set('references', buildReferencesPendingDetail(
        referenceContext.inferred
          ? 'Resolving references without an explicit References heading.'
          : 'Resolving references from the OCR text.'
      ));
      renderCounts();
      updateBackgroundStatus();
      if (state.activeDetailKind === 'references') renderSemanticDetail('references', state.detailCache.get('references'));
    }));
    const result = mergeResolvedReferenceChunks(results);
    state.referenceResolver = { status: 'ready', result, error: '', completed: chunks.length, total: chunks.length, startedAt: state.referenceResolver.startedAt || 0 };
    const bodyBlocks = bodyBlocksForResolvedReferences(result, blocks, referenceContext);
    const detail = buildReferencesDetailFromResolvedMap(result, bodyBlocks);
    if (referenceContext.inferred && detail.detail.count > 0) {
      detail.detail.warnings = cleanUserWarnings([
        ...(detail.detail.warnings || []),
        'The references section was inferred because no References heading was detected.'
      ]);
    }
    state.detailCache.set('references', detail);
    state.detailBuildStatus.set('references', 'ready');
    state.semanticCounts = { ...(state.semanticCounts || {}), referenceCount: detail.detail.count };
    markRuntime('Reference tile ready', {
      references: detail.detail.count,
      batches: chunks.length
    });
    renderCounts();
    updateStoredReviewReferenceMap(result).catch(() => {});
    if (state.activeDetailKind === 'references') renderSemanticDetail('references', detail);
    updateBackgroundStatus();
    if (state.countResolver.status !== 'running') stopProgressTicker();
  } catch (error) {
    state.referenceResolver = {
      status: 'failed',
      result: null,
      error: String(error?.message || error || 'Reference resolver failed.'),
      completed: state.referenceResolver.completed || 0,
      total: state.referenceResolver.total || 0,
      startedAt: 0
    };
    markRuntime('Reference resolver failed', { error: state.referenceResolver.error });
    updateStoredReviewReferenceFailure(state.referenceResolver.error).catch(() => {});
    state.detailCache.set('references', {
      kind: 'references',
      detail: {
        count: Number(state.semanticCounts?.referenceCount || 0),
        entries: [],
        warnings: [state.referenceResolver.error]
      }
    });
    renderCounts();
    if (state.activeDetailKind === 'references') renderSemanticDetail('references', state.detailCache.get('references'));
    updateBackgroundStatus();
    if (state.countResolver.status !== 'running') stopProgressTicker();
  }
}

async function resolveReferenceBatchWithFallback(batch = [], index = 0, options = {}) {
  try {
    const response = await resolveReferencesWithCompletion(batch, options);
    return response.result || {};
  } catch (error) {
    if (!Array.isArray(batch) || batch.length <= 1) {
      markRuntime('Reference batch failed', {
        batch: index + 1,
        error: String(error?.message || error || 'Reference batch failed.')
      });
      return {
        entries: [],
        warnings: ['One reference batch could not be resolved.']
      };
    }
    markRuntime('Reference batch retrying as smaller parts', {
      batch: index + 1,
      parts: batch.length,
      error: String(error?.message || error || 'Reference batch failed.')
    });
    const settled = await Promise.allSettled(batch.map((part) => resolveReferencesWithCompletion([part], options)));
    const retryResults = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value?.result || {});
    const failed = settled.filter((result) => result.status === 'rejected').length;
    const merged = mergeResolvedReferenceChunks(retryResults);
    return {
      entries: merged.entries,
      warnings: [
        ...merged.warnings,
        ...(failed ? [`${failed} reference part${failed === 1 ? '' : 's'} could not be resolved.`] : [])
      ]
    };
  }
}

function buildReferencesDetailFromOcr(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  const referenceContext = collectReferenceContext(blocks, positions);
  if (state.referenceResolver.result) {
    return buildReferencesDetailFromResolvedMap(
      state.referenceResolver.result,
      bodyBlocksForResolvedReferences(state.referenceResolver.result, blocks, referenceContext)
    );
  }
  return buildReferencesPendingDetail();
}

function prepareReferenceDetails(blocks = flatBlocks(), positions = blockPositionMap(blocks)) {
  try {
    const referencesDetail = buildReferencesDetailFromOcr(blocks, positions);
    state.detailCache.set('references', referencesDetail);
    state.detailBuildStatus.set('references', state.referenceResolver.result ? 'ready' : 'pending');
    if (state.activeDetailKind === 'references') renderSemanticDetail('references', referencesDetail);
    if (!state.referenceResolver.result) {
      scheduleReferenceResolver(blocks, positions).catch((error) => {
        console.warn('[deskreview-mistral-2] reference resolver failed', error);
      });
    }
  } catch (error) {
    state.detailBuildStatus.set('references', 'failed');
    state.detailCache.set('references', {
      kind: 'references',
      detail: { count: 0, warnings: [String(error?.message || error || 'Could not prepare references.')] }
    });
    if (state.activeDetailKind === 'references') renderDetailError('references', 'Could not prepare reference details.');
  }
}

function buildStoredUnavailableDetail(kind = 'abstract', message = 'This stored review does not include these saved results yet.') {
  const label = kind === 'authors'
    ? 'Authors'
    : kind === 'affiliations'
      ? 'Affiliations'
      : kind === 'keywords'
        ? 'Keywords'
        : kind;
  return {
    kind,
    detail: {
      label,
      count: null,
      items: [],
      sections: [],
      countedText: '',
      entries: [],
      pending: false,
      warnings: [message]
    }
  };
}

function scheduleDetailBuild() {
  ['authors', 'affiliations', 'keywords', 'abstract', 'article', 'references'].forEach((kind) => state.detailBuildStatus.set(kind, 'pending'));
  const blocks = flatBlocks();
  const positions = blockPositionMap(blocks);
  const allowResolverWork = !state.loadedFromLibrary;
  state.detailCache.set('references', buildReferencesPendingDetail('Reference cards will start after word counts are ready.'));
  if (state.countResolver.result) {
    const details = buildCountsDetailsFromResolvedMap(state.countResolver.result, blocks);
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
      state.detailCache.set(kind, details[kind]);
      state.detailBuildStatus.set(kind, 'ready');
      if (state.activeDetailKind === kind) renderSemanticDetail(kind, details[kind]);
    });
    state.semanticCounts = {
      ...(state.semanticCounts || {}),
      abstractWordCount: details.abstract.detail.count,
      articleWordCount: details.article.detail.count,
      authorCount: details.authors.detail.count,
      affiliationCount: details.affiliations.detail.count,
      keywordCount: details.keywords.detail.count
    };
  } else if (state.countResolver.status === 'failed' || !allowResolverWork) {
    const message = state.countResolver.error || 'This stored review was saved before these background count details were stored. Upload the PDF again once to save them with the review.';
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
      const detail = buildStoredUnavailableDetail(kind, message);
      state.detailCache.set(kind, detail);
      state.detailBuildStatus.set(kind, 'unavailable');
      if (state.activeDetailKind === kind) renderSemanticDetail(kind, detail);
    });
  } else {
    ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
      const detail = (kind === 'abstract')
        ? buildAbstractDetailFromOcr(blocks, positions)
        : (kind === 'article' ? buildArticleDetailFromOcr(blocks, positions) : buildCountsPendingDetail(kind));
      state.detailCache.set(kind, detail);
      state.detailBuildStatus.set(kind, 'pending');
      if (state.activeDetailKind === kind) renderSemanticDetail(kind, detail);
    });
  }
  renderCounts();
  if (state.countResolver.result && !state.loadedFromLibrary) {
    updateStoredReviewSemanticCounts({
      abstractWordCount: state.detailCache.get('abstract')?.detail?.count,
      articleWordCount: state.detailCache.get('article')?.detail?.count,
      authorCount: state.detailCache.get('authors')?.detail?.count,
      affiliationCount: state.detailCache.get('affiliations')?.detail?.count,
      keywordCount: state.detailCache.get('keywords')?.detail?.count
    }).catch(() => {});
  } else if (allowResolverWork && state.countResolver.status !== 'failed') {
    scheduleCountResolver(blocks, positions).catch((error) => {
      console.warn('[deskreview-mistral-2] counted-text resolver failed', error);
      state.countResolver = {
        status: 'failed',
        result: null,
        error: String(error?.message || error || 'Counted-text resolver failed.'),
        startedAt: 0
      };
      ['authors', 'affiliations', 'keywords', 'abstract', 'article'].forEach((kind) => {
        state.detailBuildStatus.set(kind, 'failed');
        state.detailCache.set(kind, {
          kind,
          detail: { count: null, warnings: [state.countResolver.error] }
        });
      });
      renderCounts();
    });
  }
  const run = () => {
    if (state.countResolver.status === 'running') return;
    if (state.referenceResolver.result) {
      prepareReferenceDetails(blocks, positions);
      const referencesDetail = state.detailCache.get('references');
      state.semanticCounts = {
        ...(state.semanticCounts || {}),
        referenceCount: referencesDetail?.detail?.count
      };
      renderCounts();
      return;
    }
    if (state.referenceResolver.status === 'failed' || !allowResolverWork) {
      const detail = buildStoredUnavailableDetail(
        'references',
        state.referenceResolver.error || 'This stored review was saved before reference details were stored. Upload the PDF again once to save them with the review.'
      );
      state.detailCache.set('references', detail);
      state.detailBuildStatus.set('references', 'unavailable');
      if (state.activeDetailKind === 'references') renderSemanticDetail('references', detail);
      renderCounts();
      return;
    }
    prepareReferenceDetails(blocks, positions);
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    window.setTimeout(run, 0);
  }
  if (allowResolverWork) {
    const annotate = () => scheduleDocumentAnnotation(blocks);
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(annotate, { timeout: 1800 });
    } else {
      window.setTimeout(annotate, 0);
    }
  }
}

function detailLinkAttributes(key = '') {
  if (!key) return '';
  return ` data-detail-block-key="${escapeHtml(key)}" tabindex="0" role="button"`;
}

function detailClickableClass(key = '') {
  return key ? ' detail-clickable detail-clickable-text' : '';
}

function renderSemanticDetail(kind = '', payload = {}) {
  const detail = payload.detail || payload || {};
  if (kind === 'abstract') {
    if (detail.pending) {
      openDetails(kind, renderCountResolvingDetail('abstract', detail));
      return;
    }
    const blockKey = findBlockKeyForQuote(detail.countedText || '');
    openDetails(kind, `
      ${renderWarnings(detail.warnings)}
      <div class="detail-card">
        <div class="detail-card-title">
          <span>What was counted</span>
          <span class="badge text-bg-light">${escapeHtml(metricValue(detail.count))} words</span>
        </div>
        <div class="detail-text${detailClickableClass(blockKey)}"${detailLinkAttributes(blockKey)}>${escapeHtml(detail.countedText || 'No abstract text was returned.')}</div>
      </div>
      ${renderExcludedText(detail.excludedText)}
    `);
    return;
  }
  if (kind === 'article') {
    if (detail.pending) {
      openDetails(kind, renderCountResolvingDetail('article', detail));
      return;
    }
    const sections = Array.isArray(detail.sections) ? detail.sections : [];
    const accordionId = 'articleSectionsAccordion';
    openDetails(kind, `
      ${renderWarnings(detail.warnings)}
      <div class="d-flex align-items-center justify-content-between gap-3 border-bottom pb-2 mb-2">
        <div class="small text-secondary">Total counted article text</div>
        <div class="d-flex align-items-baseline gap-2">
          <span class="fs-6 fw-semibold lh-1">${escapeHtml(metricValue(detail.count))}</span>
          <span class="small text-secondary">words</span>
        </div>
      </div>
      <div class="accordion accordion-flush" id="${accordionId}">
        ${sections.map((section, index) => {
        const blockKey = (Array.isArray(section.sourceBlockKeys) && section.sourceBlockKeys[0])
          ? section.sourceBlockKeys[0]
          : findBlockKeyForQuote(section.countedText || section.title || '');
        const itemId = `article-section-${index}`;
        return `
          <div class="accordion-item">
            <h3 class="accordion-header" id="${itemId}-heading">
              <button class="accordion-button collapsed py-2 px-0 bg-transparent shadow-none reader-header-label fw-normal text-secondary" type="button" data-bs-toggle="collapse" data-bs-target="#${itemId}-body" aria-expanded="false" aria-controls="${itemId}-body">
                <span class="reader-header-label fw-normal text-start flex-grow-1">${escapeHtml(section.title || `Section ${index + 1}`)}</span>
                <span class="badge text-bg-light text-secondary fw-normal ms-2 me-3">${escapeHtml(metricValue(section.count))} words</span>
              </button>
            </h3>
            <div id="${itemId}-body" class="accordion-collapse collapse" aria-labelledby="${itemId}-heading" data-bs-parent="#${accordionId}">
              <div class="accordion-body px-0 pt-0">
                <div class="detail-text${detailClickableClass(blockKey)}"${detailLinkAttributes(blockKey)}>${escapeHtml(section.countedText || '')}</div>
              </div>
            </div>
          </div>
      `;
      }).join('') || '<div class="empty-state"><i class="bi bi-file-text"></i><div>No counted article sections were returned.</div></div>'}
      </div>
      ${renderExcludedText(detail.excludedText)}
    `);
    return;
  }
  if (['authors', 'affiliations', 'keywords'].includes(kind)) {
    const label = detail.label || (kind === 'authors' ? 'Authors' : kind === 'affiliations' ? 'Affiliations' : 'Keywords');
    const unit = kind === 'authors' ? 'authors' : kind === 'affiliations' ? 'affiliations' : 'keywords';
    if (detail.pending) {
      openDetails(kind, renderProgressCard({
        title: `Resolving ${label.toLowerCase()}`,
        message: 'The manuscript is ready. These counts are being read from the OCR text in the background.',
        progress: null,
        eta: detail.elapsedMs ? formatEta(Math.max(0, 18000 - detail.elapsedMs)) : ''
      }));
      return;
    }
    const items = Array.isArray(detail.items) ? detail.items : [];
    openDetails(kind, `
      ${renderWarnings(detail.warnings)}
      <div class="d-flex align-items-center justify-content-between gap-3 border-bottom pb-2 mb-2">
        <div class="small text-secondary">${escapeHtml(label)}</div>
        <div class="d-flex align-items-baseline gap-2">
          <span class="fs-6 fw-semibold lh-1">${escapeHtml(metricValue(detail.count))}</span>
          <span class="small text-secondary">${escapeHtml(unit)}</span>
        </div>
      </div>
      ${items.map((item, index) => {
        const blockKey = (Array.isArray(item.sourceBlockKeys) && item.sourceBlockKeys[0])
          ? item.sourceBlockKeys[0]
          : findBlockKeyForQuote(item.text || '');
        return `
          <div class="w-100 border-0 rounded p-2 bg-transparent text-start${detailClickableClass(blockKey)}"${detailLinkAttributes(blockKey)}>
            <div class="small text-secondary mb-1">${escapeHtml(label.slice(0, -1) || label)} ${escapeHtml(index + 1)}</div>
            <div class="small">${escapeHtml(item.text || '')}</div>
          </div>
        `;
      }).join('') || `<div class="empty-state"><div>No ${escapeHtml(label.toLowerCase())} were returned.</div></div>`}
    `);
    return;
  }
  if (kind === 'references') {
    const entries = Array.isArray(detail.entries) ? detail.entries : [];
    if (detail.pending) {
      const message = Array.isArray(detail.warnings) && detail.warnings[0]
        ? detail.warnings[0]
        : 'The reference cards are being split from the OCR text in the background.';
      openDetails(kind, `
        ${renderProgressCard({
          title: 'Resolving references',
          message: `The manuscript is ready. ${message}`,
          progress: detail.progressPercent,
          eta: Number.isFinite(Number(detail.etaMs)) ? formatEta(detail.etaMs) : 'working in the background'
        })}
      `);
      return;
    }
    openDetails(kind, `
      ${renderWarnings(detail.warnings)}
      <div class="detail-card mb-2">
        <div class="detail-card-title"><span>References counted</span><span class="badge text-bg-light">${escapeHtml(metricValue(detail.count))}</span></div>
      </div>
      ${entries.map((entry) => {
        const refBlockKey = entry.sourceBlockKey || findBlockKeyForQuote(entry.bibliographyAnchorQuote || entry.rawText || '');
        return `
        <div class="detail-card">
          <div class="detail-card-title">
            <span>Reference ${escapeHtml(entry.number || '')}</span>
            <span class="badge text-bg-light">${escapeHtml((entry.citationOccurrences || []).length)} uses</span>
          </div>
          <div class="detail-text mb-2${detailClickableClass(refBlockKey)}"${detailLinkAttributes(refBlockKey)}>${escapeHtml(entry.rawText || '')}</div>
          ${(entry.citationOccurrences || []).map((occurrence) => {
            const occurrenceBlockKey = occurrence.blockKey || findBlockKeyForQuote(occurrence.contextQuote || occurrence.citationText || '');
            return `
            <div class="border-top py-2">
              <div class="small fw-semibold">${escapeHtml(occurrence.citationText || 'Citation')}</div>
              <div class="small text-secondary${detailClickableClass(occurrenceBlockKey)}"${detailLinkAttributes(occurrenceBlockKey)}>${escapeHtml(occurrence.contextQuote || '')}</div>
            </div>
          `;
          }).join('') || '<div class="small text-secondary border-top pt-2">No in-text citation was found for this reference.</div>'}
        </div>
      `;
      }).join('') || '<div class="empty-state"><i class="bi bi-journal-text"></i><div>No reference details were returned.</div></div>'}
    `);
  }
}

async function openCountDetails(kind = '') {
  if (!kind) return;
  if (kind === 'tables' || kind === 'figures') {
    await renderDisplayDetails(kind);
    return;
  }
  if (!state.file) return;
  if (state.detailCache.has(kind)) {
    renderSemanticDetail(kind, state.detailCache.get(kind));
    return;
  }
  renderDetailLoading(kind);
}

function renderHtmlDocument() {
  state.blockTargets.clear();
  if (!state.pages.length) {
    els.htmlDocument.innerHTML = `
      <div class="empty-state html-empty">
        <i class="bi bi-file-richtext"></i>
        <div>No OCR pages returned.</div>
      </div>
    `;
    renderEmptyToc('No OCR pages returned.');
    renderCounts();
    return;
  }
  els.htmlDocument.innerHTML = state.pages.map(renderPage).join('');
  renderToc();
  renderCounts();
  renderAllRegions();
}

function updateMetrics(data = {}, file = null) {
  const elapsed = Number(data.elapsedMs || 0);
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const characterCount = pages.reduce((total, page) => {
    const pageText = String(page.markdown || page.text || '');
    const blockTextTotal = getBlocks(page).reduce((sum, block) => sum + blockText(block).length, 0);
    return total + Math.max(pageText.length, blockTextTotal);
  }, 0);
  setBadge(els.elapsedBadge, elapsed ? formatDuration(elapsed) : '');
  setBadge(els.pagesBadge, pages.length ? String(pages.length) : '');
  setBadge(els.charsBadge, characterCount ? String(characterCount) : '');
  setBadge(els.sizeBadge, file ? formatBytes(file.size) : '');
}

function sourceScales(target = {}) {
  const pageView = state.pageViews.get(target.pageNumber);
  const page = state.pages.find((candidate, index) => pageNumber(candidate, index) === target.pageNumber);
  if (!pageView || !page) return null;
  const dimensions = pageDimensions(page, pageView);
  return {
    pageView,
    xScale: pageView.viewport.width / dimensions.width,
    yScale: pageView.viewport.height / dimensions.height
  };
}

function drawActivePdfRegion(key = '') {
  document.querySelectorAll('.pdf-active-region').forEach((node) => node.remove());
  const target = state.blockTargets.get(key);
  if (!target?.box) return;
  const scales = sourceScales(target);
  if (!scales) return;
  const highlight = document.createElement('div');
  highlight.className = 'pdf-active-region';
  highlight.style.left = `${target.box.left * scales.xScale}px`;
  highlight.style.top = `${target.box.top * scales.yScale}px`;
  highlight.style.width = `${(target.box.right - target.box.left) * scales.xScale}px`;
  highlight.style.height = `${(target.box.bottom - target.box.top) * scales.yScale}px`;
  scales.pageView.wrapper.appendChild(highlight);
}

function scrollPdfToBlock(target = {}) {
  const pageView = state.pageViews.get(target.pageNumber);
  if (!pageView) return;
  let top = pageView.wrapper.offsetTop - 40;
  if (target.box) {
    const scales = sourceScales(target);
    if (scales) top = pageView.wrapper.offsetTop + target.box.top * scales.yScale - 72;
  }
  els.pdfScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function scrollHtmlToBlock(key = '') {
  const htmlBlock = document.getElementById(key);
  if (!htmlBlock) return;
  htmlBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updatePdfSearchUi() {
  const total = state.pdfSearch.matches.length;
  const current = total && state.pdfSearch.index >= 0 ? state.pdfSearch.index + 1 : 0;
  const hasQuery = Boolean(String(els.pdfSearchInput?.value || '').trim());
  if (els.pdfSearchCount) els.pdfSearchCount.textContent = `${current} / ${total}`;
  if (els.pdfSearchPrev) els.pdfSearchPrev.disabled = !hasQuery;
  if (els.pdfSearchNext) els.pdfSearchNext.disabled = !hasQuery;
}

function resetPdfSearch() {
  state.pdfSearch = { query: '', matches: [], index: -1 };
  if (els.pdfSearchInput) els.pdfSearchInput.value = '';
  updatePdfSearchUi();
}

function searchPattern(query = '') {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;
  return new RegExp(escapeRegExp(trimmed).replace(/\s+/g, '\\s+'), 'giu');
}

function runPdfSearch(direction = 1) {
  const query = String(els.pdfSearchInput?.value || '').trim();
  const pattern = searchPattern(query);
  state.pdfSearch.query = query;
  state.pdfSearch.matches = [];
  state.pdfSearch.index = -1;
  if (!pattern) {
    updatePdfSearchUi();
    return;
  }
  flatBlocks().forEach((block) => {
    const text = block.plainText || ocrPlainText(block.text || '');
    if (!text) return;
    for (const match of text.matchAll(pattern)) {
      state.pdfSearch.matches.push({
        blockKey: block.key,
        citationText: match[0],
        offset: match.index || 0
      });
    }
  });
  if (state.pdfSearch.matches.length) {
    state.pdfSearch.index = direction < 0 ? state.pdfSearch.matches.length - 1 : 0;
    focusPdfSearchMatch();
  }
  updatePdfSearchUi();
}

function focusPdfSearchMatch() {
  const match = state.pdfSearch.matches[state.pdfSearch.index];
  if (!match) {
    updatePdfSearchUi();
    return;
  }
  if (state.activeView !== 'pdf') switchView('pdf');
  window.requestAnimationFrame(() => focusBlock(match.blockKey, 'search'));
  updatePdfSearchUi();
}

function stepPdfSearch(delta = 1) {
  const query = String(els.pdfSearchInput?.value || '').trim();
  if (query !== state.pdfSearch.query) {
    runPdfSearch(delta);
    return;
  }
  const total = state.pdfSearch.matches.length;
  if (!total) {
    runPdfSearch(delta);
    return;
  }
  state.pdfSearch.index = (state.pdfSearch.index + delta + total) % total;
  focusPdfSearchMatch();
}

function focusBlock(key = '', source = 'html') {
  const target = state.blockTargets.get(key);
  if (!target) return;
  state.activeBlockKey = key;
  syncActiveToc(key);
  els.htmlDocument.querySelectorAll('.ocr-block.active').forEach((node) => node.classList.remove('active'));
  const htmlBlock = document.getElementById(key);
  if (htmlBlock) {
    htmlBlock.classList.add('active');
    if (source !== 'html' && state.activeView === 'html') scrollHtmlToBlock(key);
  }
  scrollPdfToBlock(target);
  drawActivePdfRegion(key);
}

function switchView(view = 'pdf') {
  const next = view === 'html' ? 'html' : 'pdf';
  state.activeView = next;
  els.pdfTab.classList.toggle('active', next === 'pdf');
  els.htmlTab.classList.toggle('active', next === 'html');
  els.pdfTab.setAttribute('aria-selected', next === 'pdf' ? 'true' : 'false');
  els.htmlTab.setAttribute('aria-selected', next === 'html' ? 'true' : 'false');
  els.pdfView.classList.toggle('active', next === 'pdf');
  els.htmlView.classList.toggle('active', next === 'html');
  window.requestAnimationFrame(() => {
    if (next === 'pdf') schedulePdfFitRender(0);
    if (!state.activeBlockKey) return;
    if (next === 'pdf') scrollPdfToBlock(state.blockTargets.get(state.activeBlockKey));
    if (next === 'html') scrollHtmlToBlock(state.activeBlockKey);
  });
}

function resetReaderState(file = null) {
  clearCheckRevealTimers();
  state.file = file;
  state.startedAt = performance.now();
  state.pages = [];
  state.blockTargets.clear();
  state.tocEntries = [];
  state.activeBlockKey = '';
  state.semanticCounts = null;
  state.detailCache.clear();
  state.detailBuildStatus.clear();
  state.currentReviewId = '';
  state.currentReview = null;
  state.loadedFromLibrary = false;
  state.referenceResolver = { status: 'idle', result: null, error: '', completed: 0, total: 0, startedAt: 0 };
  state.countResolver = { status: 'idle', result: null, error: '', startedAt: 0 };
  state.displayResolver = { status: 'idle', result: null, error: '', startedAt: 0 };
  state.displayResolverPromise = null;
  state.documentAnnotation = { status: 'idle', result: null, error: '', startedAt: 0 };
  state.documentAnnotationPromise = null;
  state.essentialResults = [];
  state.pdfSearch = { query: '', matches: [], index: -1 };
  state.ocrProgress = { status: 'idle', startedAt: 0, estimateMs: 18000 };
  state.checkReveal = { phase: 'idle', startedAt: 0, visibleKinds: [], resultKinds: [], lastResultAt: 0, resultTimer: 0, timers: [] };
  state.tileReady = {};
  state.tilePulseUntil = {};
  stopProgressTicker();
  closeDetails();
  renderEssentialGuidelines();
  resetPdfSearch();
  if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
}

async function saveReviewToLibrary(file = null, ocr = {}) {
  if (!file || !Array.isArray(ocr.pages)) return null;
  const now = new Date().toISOString();
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const review = {
    id,
    fileName: file.name || 'manuscript.pdf',
    mimeType: file.type || 'application/pdf',
    size: file.size || 0,
    createdAt: now,
    updatedAt: now,
    pageCount: ocr.pages.length,
    model: ocr.model || 'mistral-ocr-latest',
    pdfBlob: file,
    ocr: {
      elapsedMs: ocr.elapsedMs || 0,
      model: ocr.model || '',
      pages: ocr.pages,
      semanticCounts: ocr.semanticCounts || null,
      usage_info: ocr.usage_info || null
    },
    referenceResolver: null,
    countResolver: null,
    displayResolver: null,
    documentAnnotation: null
  };
  await putStoredReview(review);
  state.currentReviewId = id;
  state.currentReview = review;
  refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
  return review;
}

function hydrateSemanticCountsFromSavedResults(blocks = flatBlocks()) {
  const semanticCounts = { ...(state.semanticCounts || {}) };
  if (state.countResolver.result) {
    const details = buildCountsDetailsFromResolvedMap(state.countResolver.result, blocks);
    semanticCounts.abstractWordCount = details.abstract.detail.count;
    semanticCounts.articleWordCount = details.article.detail.count;
    semanticCounts.authorCount = details.authors.detail.count;
    semanticCounts.affiliationCount = details.affiliations.detail.count;
    semanticCounts.keywordCount = details.keywords.detail.count;
  }
  if (state.referenceResolver.result) {
    const positions = blockPositionMap(blocks);
    const referenceContext = collectReferenceContext(blocks, positions);
    const bodyBlocks = bodyBlocksForResolvedReferences(state.referenceResolver.result, blocks, referenceContext);
    const detail = buildReferencesDetailFromResolvedMap(state.referenceResolver.result, bodyBlocks);
    semanticCounts.referenceCount = detail.detail.count;
  }
  state.semanticCounts = semanticCounts;
}

async function renderReviewFromRecord(review = {}) {
  if (!review?.pdfBlob || !review?.ocr) return;
  const file = new File([review.pdfBlob], review.fileName || 'manuscript.pdf', {
    type: review.mimeType || 'application/pdf',
    lastModified: new Date(review.updatedAt || review.createdAt || Date.now()).getTime()
  });
  resetReaderState(file);
  resetRuntime(review.fileName || 'stored review');
  markRuntime('Loaded from library', {
    pages: Array.isArray(review.ocr.pages) ? review.ocr.pages.length : 0
  });
  state.currentReviewId = review.id || '';
  state.currentReview = review;
  state.loadedFromLibrary = true;
  if (review.referenceResolver?.status === 'ready' && review.referenceResolver.result) {
    const count = Array.isArray(review.referenceResolver.result.entries) ? review.referenceResolver.result.entries.length : 0;
    state.referenceResolver = { status: 'ready', result: review.referenceResolver.result, error: '', completed: count, total: count, startedAt: 0 };
  } else if (review.referenceResolver?.status === 'failed') {
    state.referenceResolver = {
      status: 'failed',
      result: null,
      error: String(review.referenceResolver.error || 'Reference details were not available in this stored review.'),
      completed: 0,
      total: 0,
      startedAt: 0
    };
  }
  if (review.countResolver?.status === 'ready' && review.countResolver.result) {
    state.countResolver = { status: 'ready', result: review.countResolver.result, error: '', startedAt: 0 };
  } else if (review.countResolver?.status === 'failed') {
    state.countResolver = {
      status: 'failed',
      result: null,
      error: String(review.countResolver.error || 'Count details were not available in this stored review.'),
      startedAt: 0
    };
  }
  if (review.displayResolver?.status === 'ready' && review.displayResolver.result) {
    state.displayResolver = { status: 'ready', result: review.displayResolver.result, error: '', startedAt: 0 };
  } else if (review.displayResolver?.status === 'failed') {
    state.displayResolver = {
      status: 'failed',
      result: null,
      error: String(review.displayResolver.error || 'Table/figure details were not available in this stored review.'),
      startedAt: 0
    };
  }
  if (review.documentAnnotation?.status === 'ready' && review.documentAnnotation.result) {
    state.documentAnnotation = {
      status: 'ready',
      result: normalizeDocumentAnnotation(review.documentAnnotation.result),
      error: '',
      startedAt: 0
    };
  } else if (review.documentAnnotation?.status === 'failed') {
    state.documentAnnotation = {
      status: 'failed',
      result: null,
      error: String(review.documentAnnotation.error || 'Document annotation was not available in this stored review.'),
      startedAt: 0
    };
  }
  renderEssentialGuidelines();
  state.pdfUrl = URL.createObjectURL(review.pdfBlob);
  state.pages = Array.isArray(review.ocr.pages) ? review.ocr.pages : [];
  state.semanticCounts = review.ocr.semanticCounts || null;
  hydrateSemanticCountsFromSavedResults(flatBlocks());
  showReader();
  switchView('pdf');
  setBadge(els.elapsedBadge, '');
  setBadge(els.pagesBadge, '');
  setBadge(els.charsBadge, '');
  setBadge(els.sizeBadge, formatBytes(review.size || file.size));
  setStatus('Loaded from library', 'done');
  renderLoadingHtml();
  const pdfPromise = renderPdfDocument().catch((error) => {
    console.warn('[deskreview-mistral-2] stored PDF render failed', error);
  });
  updateMetrics({ ...review.ocr, elapsedMs: 0 }, file);
  renderHtmlDocument();
  markRuntime('HTML reader rendered from library', {
    pages: state.pages.length,
    blocks: flatBlocks().length
  });
  scheduleDetailBuild();
  await pdfPromise;
  markRuntime('PDF rendered from library', {
    pages: Number(state.pdfDoc?.numPages || 0)
  });
  renderAllRegions();
}

async function handleFile(file = null) {
  if (!file) return;
  resetReaderState(file);
  resetRuntime(file.name || 'manuscript.pdf');
  state.pdfUrl = URL.createObjectURL(file);
  showReader();
  switchView('pdf');
  if (els.fileName) els.fileName.textContent = file.name;
  setBadge(els.elapsedBadge, '');
  setBadge(els.pagesBadge, '');
  setBadge(els.charsBadge, '');
  setBadge(els.sizeBadge, formatBytes(file.size));
  state.ocrProgress = { status: 'running', startedAt: performance.now(), estimateMs: 18000 };
  setStatus(`Parsing · ${formatEta(state.ocrProgress.estimateMs)}`, 'running');
  renderLoadingHtml();
  startProgressTicker();

  const pdfPromise = renderPdfDocument().catch((error) => {
    console.warn('[deskreview-mistral-2] PDF render failed', error);
  });

  try {
    const ocr = await runOcr(file);
    state.pages = Array.isArray(ocr.pages) ? ocr.pages : [];
    state.semanticCounts = ocr.semanticCounts || null;
    state.ocrProgress.status = 'done';
    updateMetrics(ocr, file);
    startCheckReveal();
    renderHtmlDocument();
    markRuntime('HTML reader rendered', {
      pages: state.pages.length,
      blocks: flatBlocks().length
    });
    await saveReviewToLibrary(file, ocr).catch((error) => {
      console.warn('[deskreview-mistral-2] could not store review', error);
    });
    scheduleDetailBuild();
    const total = performance.now() - state.startedAt;
    setStatus(`OCR ready in ${formatDuration(total)}`, 'done');
  } catch (error) {
    console.error(error);
    state.ocrProgress.status = 'failed';
    stopProgressTicker();
    setStatus('OCR failed', 'error');
    els.htmlDocument.innerHTML = `<div class="alert alert-danger m-3">${escapeHtml(error?.message || error || 'OCR failed.')}</div>`;
  }

  await pdfPromise;
  markRuntime('PDF rendered', {
    pages: Number(state.pdfDoc?.numPages || 0)
  });
  renderAllRegions();
}

function pageText(number = 1) {
  const section = els.htmlDocument.querySelector(`[data-html-page="${number}"]`);
  return String(section?.innerText || '').trim();
}

function clampNumber(value = 0, min = 0, max = 0) {
  return Math.max(min, Math.min(max, value));
}

function paneWidth(selector = '') {
  return els.reader.querySelector(selector)?.getBoundingClientRect().width || 0;
}

function setPaneWidth(kind = 'toc', width = 0) {
  const property = kind === 'toc' ? '--toc-width' : '--counts-width';
  els.reader.style.setProperty(property, `${Math.round(width)}px`);
  schedulePdfFitRender(90);
}

function setTocOpen(open = true) {
  state.tocOpen = Boolean(open);
  els.reader.classList.toggle('toc-collapsed', !state.tocOpen);
  els.tocToggleButton?.setAttribute('aria-expanded', String(state.tocOpen));
  schedulePdfFitRender(180);
}

function resizePaneFromPointer(kind = '', clientX = 0) {
  const rect = els.reader.getBoundingClientRect();
  const currentToc = state.tocOpen ? (paneWidth('.studio-toc-pane') || 288) : 0;
  const currentCounts = paneWidth('.studio-counts-pane') || 320;
  const splitterTotal = 12;
  const minimumCenter = 440;
  if (kind === 'toc') {
    const max = Math.max(180, rect.width - currentCounts - splitterTotal - minimumCenter);
    setPaneWidth('toc', clampNumber(clientX - rect.left, 180, max));
    return;
  }
  if (kind === 'counts') {
    const max = Math.max(240, rect.width - currentToc - splitterTotal - minimumCenter);
    setPaneWidth('counts', clampNumber(rect.right - clientX, 240, max));
  }
}

function resizePaneByStep(kind = '', step = 0) {
  const rect = els.reader.getBoundingClientRect();
  const currentToc = state.tocOpen ? (paneWidth('.studio-toc-pane') || 288) : 0;
  const currentCounts = paneWidth('.studio-counts-pane') || 320;
  const splitterTotal = 12;
  const minimumCenter = 440;
  if (kind === 'toc') {
    const max = Math.max(180, rect.width - currentCounts - splitterTotal - minimumCenter);
    setPaneWidth('toc', clampNumber(currentToc + step, 180, max));
    return;
  }
  if (kind === 'counts') {
    const max = Math.max(240, rect.width - currentToc - splitterTotal - minimumCenter);
    setPaneWidth('counts', clampNumber(currentCounts - step, 240, max));
  }
}

function initSplitter(splitter, kind = '') {
  if (!splitter) return;
  splitter.addEventListener('pointerdown', (event) => {
    state.activeSplitter = kind;
    els.reader.classList.add('is-resizing');
    splitter.setPointerCapture(event.pointerId);
    resizePaneFromPointer(kind, event.clientX);
  });
  splitter.addEventListener('pointerup', (event) => {
    state.activeSplitter = '';
    els.reader.classList.remove('is-resizing');
    splitter.releasePointerCapture(event.pointerId);
    schedulePdfFitRender(0);
  });
  splitter.addEventListener('pointercancel', () => {
    state.activeSplitter = '';
    els.reader.classList.remove('is-resizing');
  });
  splitter.addEventListener('pointermove', (event) => {
    if (state.activeSplitter !== kind) return;
    resizePaneFromPointer(kind, event.clientX);
  });
  splitter.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    resizePaneByStep(kind, direction * 24);
  });
}

function initPdfResizeObserver() {
  if (!('ResizeObserver' in window) || !els.pdfScroll) return;
  const observer = new ResizeObserver(() => schedulePdfFitRender(180));
  observer.observe(els.pdfScroll);
}

function scrollPaneByWheel(event, scroller) {
  if (!scroller) return;
  const beforeTop = scroller.scrollTop;
  const beforeLeft = scroller.scrollLeft;
  scroller.scrollTop += event.deltaY;
  scroller.scrollLeft += event.deltaX;
  if (scroller.scrollTop !== beforeTop || scroller.scrollLeft !== beforeLeft) {
    event.preventDefault();
  }
}

els.homeInput.addEventListener('change', async () => {
  const file = els.homeInput.files?.[0] || null;
  try {
    await handleFile(file);
  } finally {
    els.homeInput.value = '';
  }
});

els.tocToggleButton?.addEventListener('click', () => {
  setTocOpen(!state.tocOpen);
});

els.reviewLibraryBody.addEventListener('click', async (event) => {
  const deleteButton = event.target.closest('[data-delete-review-id]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    showDeleteReviewModal(deleteButton.dataset.deleteReviewId);
    return;
  }
  const row = event.target.closest('[data-review-id]');
  if (!row) return;
  const review = await getStoredReview(row.dataset.reviewId);
  await renderReviewFromRecord(review);
});

els.reviewLibraryBody.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('[data-delete-review-id]')) return;
  const row = event.target.closest('[data-review-id]');
  if (!row) return;
  event.preventDefault();
  const review = await getStoredReview(row.dataset.reviewId);
  await renderReviewFromRecord(review);
});

els.htmlDocument.addEventListener('click', (event) => {
  const block = event.target.closest('[data-block-id]');
  if (block) focusBlock(block.dataset.blockId, 'html');
});

els.htmlDocument.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const block = event.target.closest('[data-block-id]');
  if (!block) return;
  event.preventDefault();
  focusBlock(block.dataset.blockId, 'html');
});

els.pdfTab.addEventListener('click', () => switchView('pdf'));
els.htmlTab.addEventListener('click', () => switchView('html'));
els.pdfSearchInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  stepPdfSearch(event.shiftKey ? -1 : 1);
});
els.pdfSearchInput?.addEventListener('input', () => {
  state.pdfSearch.query = '';
  state.pdfSearch.matches = [];
  state.pdfSearch.index = -1;
  updatePdfSearchUi();
});
els.pdfSearchPrev?.addEventListener('click', () => stepPdfSearch(-1));
els.pdfSearchNext?.addEventListener('click', () => stepPdfSearch(1));
els.libraryBack.addEventListener('click', () => {
  showHome();
  refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
});

els.tocList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-toc-block-key]');
  if (!button) return;
  focusBlock(button.dataset.tocBlockKey, 'toc');
});

els.countsGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-count-kind]');
  if (!button) return;
  openCountDetails(button.dataset.countKind).catch((error) => {
    renderDetailError(button.dataset.countKind, error?.message || String(error || 'Could not load details.'));
  });
});

els.essentialGuideList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-essential-guide-id]');
  if (!button) return;
  renderEssentialGuideDetails(button.dataset.essentialGuideId);
});

els.runtimeSummaryModal?.addEventListener('show.bs.modal', renderRuntimeSummary);
els.runtimeSummaryButton?.addEventListener('click', renderRuntimeSummary);
els.runtimeSummaryCopy?.addEventListener('click', () => {
  renderRuntimeSummary();
  navigator.clipboard?.writeText(runtimeSummaryText()).catch(() => {});
});

els.deleteReviewConfirm?.addEventListener('click', async () => {
  const reviewId = state.pendingDeleteReviewId;
  if (!reviewId) return;
  els.deleteReviewConfirm.disabled = true;
  try {
    await deleteStoredReview(reviewId);
    state.pendingDeleteReviewId = '';
    await refreshLibrary();
    window.bootstrap?.Modal?.getInstance(els.deleteReviewModal)?.hide();
  } finally {
    els.deleteReviewConfirm.disabled = false;
  }
});

els.deleteReviewModal?.addEventListener('hidden.bs.modal', () => {
  state.pendingDeleteReviewId = '';
  if (els.deleteReviewName) els.deleteReviewName.textContent = '';
});

els.feedbackReportModal?.addEventListener('show.bs.modal', renderFeedbackReport);
els.feedbackReportButton?.addEventListener('click', renderFeedbackReport);
els.feedbackReportPdf?.addEventListener('click', openFeedbackReportPdf);

els.detailsPanelClose.addEventListener('click', closeDetails);

els.detailsPanelBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-detail-block-key]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  focusBlock(button.dataset.detailBlockKey, 'details');
});

els.detailsPanelBody.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[data-detail-block-key]');
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  focusBlock(target.dataset.detailBlockKey, 'details');
});

els.pdfScroll.addEventListener('wheel', (event) => scrollPaneByWheel(event, els.pdfScroll), { passive: false });
els.htmlScroll.addEventListener('wheel', (event) => scrollPaneByWheel(event, els.htmlScroll), { passive: false });

initSplitter(els.tocSplitter, 'toc');
initSplitter(els.countsSplitter, 'counts');
initPdfResizeObserver();
showHome();
loadEssentialGuides()
  .then((guides) => {
    state.essentialGuides = guides;
    state.essentialStatus = 'ready';
    renderEssentialGuidelines();
  })
  .catch((error) => {
    state.essentialStatus = 'failed';
    if (els.essentialGuideList) {
      els.essentialGuideList.innerHTML = `<div class="alert alert-light border small mb-0">${escapeHtml(error?.message || error || 'Essential guidelines could not be loaded.')}</div>`;
    }
    if (els.essentialGuidelineSummary) {
      els.essentialGuidelineSummary.className = 'badge text-bg-danger ms-auto';
      els.essentialGuidelineSummary.textContent = 'Failed';
    }
  });
refreshLibrary().catch((error) => console.warn('[deskreview-mistral-2] library refresh failed', error));
