import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(19000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, text };
}

async function waitForServer(child) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 8000) {
    if (child.exitCode != null) {
      throw new Error(`Server exited early with code ${child.exitCode}.`);
    }
    try {
      const { response } = await request('/');
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Server did not become ready: ${lastError?.message || 'timeout'}`);
}

async function main() {
  const indexHtml = await readFile('public/index.html', 'utf8');
  assert(indexHtml.includes('id="reviewLibraryBody"'), 'Home library table body is missing.');
  assert(indexHtml.includes('id="reader"'), 'Reader shell is missing.');
  assert(indexHtml.includes('id="tocList"'), 'ToC list is missing.');
  assert(indexHtml.includes('id="countsGrid"'), 'Counts grid is missing.');
  assert(indexHtml.includes('id="essentialGuideList"'), 'Essential guide list is missing.');
  assert(indexHtml.includes('id="detailsPanel"'), 'Details panel is missing.');

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || 'baseline-test-key',
      DESKREVIEW_ENV_FILE: '/dev/null'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer(child);

    const home = await request('/');
    assert(home.response.status === 200, `Expected / to return 200, got ${home.response.status}.`);
    assert(home.text.includes('Stored desk reviews'), 'Home page copy is missing.');
    assert(home.text.includes('/app.js'), 'App module script is missing.');

    const app = await request('/app.js');
    assert(app.response.status === 200, `Expected /app.js to return 200, got ${app.response.status}.`);
    assert(app.text.includes('/app/reader.js'), 'Public app entrypoint does not load the reader module.');

    const reader = await request('/app/reader.js');
    assert(reader.response.status === 200, `Expected /app/reader.js to return 200, got ${reader.response.status}.`);
    assert(reader.text.includes('renderToc'), 'Reader module does not include ToC rendering.');

    const tocCore = await request('/core/toc.js');
    assert(tocCore.response.status === 200, `Expected /core/toc.js to return 200, got ${tocCore.response.status}.`);
    assert(tocCore.text.includes('projectTocEntries'), 'ToC core module is missing.');

    const countProgressCore = await request('/core/count-progress.js');
    assert(countProgressCore.response.status === 200, `Expected /core/count-progress.js to return 200, got ${countProgressCore.response.status}.`);
    assert(countProgressCore.text.includes('buildCountProgress'), 'Count progress core module is missing.');

    const documentAnnotationCore = await request('/core/document-annotation.js');
    assert(documentAnnotationCore.response.status === 200, `Expected /core/document-annotation.js to return 200, got ${documentAnnotationCore.response.status}.`);
    assert(documentAnnotationCore.text.includes('normalizeDocumentAnnotation'), 'Document annotation core module is missing.');

    const essentialCore = await request('/core/essential-guidelines.js');
    assert(essentialCore.response.status === 200, `Expected /core/essential-guidelines.js to return 200, got ${essentialCore.response.status}.`);
    assert(essentialCore.text.includes('evaluateEssentialGuides'), 'Essential guideline core module is missing.');

    const guidelineDetailCore = await request('/core/guideline-detail.js');
    assert(guidelineDetailCore.response.status === 200, `Expected /core/guideline-detail.js to return 200, got ${guidelineDetailCore.response.status}.`);
    assert(guidelineDetailCore.text.includes('filterGuideResults'), 'Guideline detail core module is missing.');

    const essentialData = await request('/data/ease-essential-guidelines.json');
    assert(essentialData.response.status === 200, `Expected /data/ease-essential-guidelines.json to return 200, got ${essentialData.response.status}.`);
    assert(essentialData.text.includes('EASE Essentials'), 'Essential guideline data is missing.');

    const libraryService = await request('/services/browser-library.js');
    assert(libraryService.response.status === 200, `Expected /services/browser-library.js to return 200, got ${libraryService.response.status}.`);
    assert(libraryService.text.includes('listStoredReviews'), 'Browser library service is missing.');

    const annotation = await request('/api/annotate-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert(annotation.response.status === 400, `Expected empty annotation request to return 400, got ${annotation.response.status}.`);
    assert(annotation.text.includes('Missing OCR blocks'), 'Annotation validation response changed unexpectedly.');

    const styles = await request('/styles.css');
    assert(styles.response.status === 200, `Expected /styles.css to return 200, got ${styles.response.status}.`);
    assert(styles.text.includes('.pdf-active-region'), 'PDF active-region styling is missing.');

    const ocr = await request('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert(ocr.response.status === 400, `Expected empty OCR request to return 400, got ${ocr.response.status}.`);
    assert(ocr.text.includes('Missing PDF base64 payload'), 'OCR validation response changed unexpectedly.');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(1000).then(() => child.kill('SIGKILL'))
    ]);
  }

  if (!/listening on/.test(output)) {
    throw new Error('Server did not print its listening message.');
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
