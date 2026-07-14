function countWords(value = '') {
  return (String(value || '').match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length;
}

export function normalizeTocLabel(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isBodyTocLabel(label = '') {
  const value = String(label || '').trim();
  return /^(abstract|summary|keywords?|introduction|background|methods?|materials?|results?|discussion|conclusions?|references?|bibliography|acknowledg)/i.test(value)
    || /^[ivxlcdm]+\.\s+\S/i.test(value)
    || /^\d+(?:\.\d+)*\.?\s+\S/.test(value);
}

export function isTitleLikeTocEntry(entry = {}) {
  const label = String(entry.label || '').trim();
  if (!label || isBodyTocLabel(label)) return false;
  const normalized = normalizeTocLabel(label);
  if (!normalized || normalized === 'title') return false;
  return countWords(label) >= 4 || label.length >= 24;
}

export function firstBodyTocIndex(entries = []) {
  const index = entries.findIndex((entry) => isBodyTocLabel(entry.label));
  return index >= 0 ? index : entries.length;
}

export function projectTocEntries(entries = []) {
  const projected = entries.map((entry) => ({
    ...entry,
    normalizedLabel: normalizeTocLabel(entry.label),
    displayLabel: entry.label
  }));
  const bodyStart = firstBodyTocIndex(projected);
  const preBody = projected.slice(0, bodyStart);
  const titleCounts = new Map();
  preBody
    .filter(isTitleLikeTocEntry)
    .forEach((entry) => {
      titleCounts.set(entry.normalizedLabel, (titleCounts.get(entry.normalizedLabel) || 0) + 1);
    });

  let titleIndex = -1;
  for (let index = preBody.length - 1; index >= 0; index -= 1) {
    const entry = preBody[index];
    if (isTitleLikeTocEntry(entry) && titleCounts.get(entry.normalizedLabel) > 1) {
      titleIndex = index;
      break;
    }
  }
  if (titleIndex < 0) {
    titleIndex = preBody.findIndex(isTitleLikeTocEntry);
  }
  if (titleIndex < 0 && preBody[0]?.normalizedLabel === 'title') {
    titleIndex = 0;
  }
  if (titleIndex >= 0) {
    projected[titleIndex].displayLabel = 'Title';
  }

  const titleNorm = titleIndex >= 0 ? projected[titleIndex].normalizedLabel : '';
  return projected
    .filter((entry, index) => {
      if (titleIndex < 0 || index >= bodyStart) return true;
      if (index >= titleIndex) return true;
      if (entry.normalizedLabel === 'title') return false;
      return !(titleNorm && entry.normalizedLabel === titleNorm);
    })
    .map(({ normalizedLabel, ...entry }) => entry);
}
