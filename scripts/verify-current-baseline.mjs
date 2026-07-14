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
    assert(app.text.includes('renderToc'), 'App bundle does not include ToC rendering.');

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
