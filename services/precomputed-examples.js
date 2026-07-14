export async function loadPrecomputedExamplePayload(example = {}) {
  const jsonPath = String(example.precomputedPath || '').trim();
  if (!jsonPath) throw new Error('This example does not have precomputed results.');
  const response = await fetch(jsonPath);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new Error(`Precomputed example failed to load (${response.status}).`);
  }
  return payload;
}

export async function loadPrecomputedExamplePdf(example = {}) {
  const pdfPath = String(example.pdfPath || '').trim();
  if (!pdfPath) throw new Error('This example does not have a PDF asset.');
  const response = await fetch(pdfPath);
  const blob = await response.blob();
  if (!response.ok || !blob.size) {
    throw new Error(`Example PDF failed to load (${response.status}).`);
  }
  return blob;
}
