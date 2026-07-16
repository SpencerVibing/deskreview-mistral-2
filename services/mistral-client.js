async function postJson(path = '', payload = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const label = path.replace(/^\/api\//, '').replace(/-/g, ' ') || 'request';
    throw new Error(data?.error || `${label} failed (${response.status}).`);
  }
  return data;
}

export function requestOcr({ fileName = 'manuscript.pdf', mimeType = 'application/pdf', base64 = '' } = {}) {
  return postJson('/api/ocr', { fileName, mimeType, base64 });
}

export function requestOcrCountAnnotation({ fileName = 'manuscript.pdf', mimeType = 'application/pdf', base64 = '' } = {}) {
  return postJson('/api/ocr-count-annotation', { fileName, mimeType, base64 });
}

export function resolveReferences(referenceBlocks = [], options = {}) {
  return postJson('/api/resolve-references', {
    referenceBlocks,
    inferBibliographyRegion: Boolean(options.inferBibliographyRegion)
  });
}

export function resolveCounts(blocks = []) {
  return postJson('/api/resolve-counts', { blocks });
}

export function resolveDisplayItems(displayItems = [], bodyBlocks = []) {
  return postJson('/api/resolve-display-items', { displayItems, bodyBlocks });
}

export function annotateDocument(payload = {}) {
  return postJson('/api/annotate-document', payload);
}

export function evaluateEssentialGuidelines(payload = {}) {
  return postJson('/api/evaluate-essential-guidelines', payload);
}

export function matchReportingGuidelines(payload = {}) {
  return postJson('/api/match-guidelines', payload);
}

export function requestGroundedChat(payload = {}) {
  return postJson('/api/chat', payload);
}
