export function displayTopLevelLabel(item = {}) {
  const kind = String(item.kind || '').toLowerCase();
  const label = String(item.label || '').trim();
  const citationText = Array.isArray(item.citationOccurrences)
    ? item.citationOccurrences.map((occurrence) => occurrence?.citationText || '').join(' ')
    : '';
  const text = `${label} ${citationText}`.trim();
  const pattern = kind === 'table'
    ? /\b(?:table|tab\.?)\s+((?:s\s*)?\d+|[ivxlcdm]+)\b/i
    : /\b(?:fig(?:ure)?\.?)\s+((?:s\s*)?\d+|[ivxlcdm]+)\s*(?:[\s(.-]*[a-z]\)?)?/i;
  const match = text.match(pattern);
  if (!match) return null;
  const rawNumber = String(match[1] || '').replace(/\s+/g, '').toUpperCase();
  if (!rawNumber || rawNumber.startsWith('S')) {
    return {
      excluded: true,
      reason: `${kind === 'table' ? 'Supplementary table' : 'Supplementary figure'} labels are not counted as manuscript body display items.`
    };
  }
  return {
    key: `${kind}:${rawNumber}`,
    label: `${kind === 'table' ? 'Table' : 'Figure'} ${rawNumber}`
  };
}

export function mergeCitationOccurrences(existing = [], incoming = []) {
  const seen = new Set();
  return [...existing, ...incoming].filter((occurrence) => {
    const signature = [
      occurrence?.blockKey || '',
      occurrence?.citationText || '',
      occurrence?.contextQuote || ''
    ].join('::');
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function normalizeResolvedDisplayItems({ resolvedItems = [], sourceItems = [] } = {}) {
  const sourceById = new Map(sourceItems.map((item) => [item.itemId, item]));
  const normalized = [];
  const byTopLevel = new Map();
  const seenItemIds = new Set();
  (Array.isArray(resolvedItems) ? resolvedItems : [])
    .forEach((item, index) => {
      const source = sourceById.get(String(item.itemId || '')) || {};
      const kind = String(item.kind || source.kind || '').toLowerCase();
      const merged = {
        ...source,
        ...item,
        kind,
        label: String(item.label || source.label || `${kind === 'figure' ? 'Figure' : 'Table'} ${index + 1}`),
        key: String(source.sourceBlockKey || source.key || item.sourceBlockKey || ''),
        citationOccurrences: Array.isArray(item.citationOccurrences) ? item.citationOccurrences : []
      };
      if (kind !== 'table' && kind !== 'figure') return;
      if (!item?.isManuscriptItem) {
        normalized.push(merged);
        return;
      }
      const topLevel = displayTopLevelLabel(merged);
      const itemId = String(item.itemId || source.itemId || '');
      if (!topLevel || topLevel.excluded || (itemId && seenItemIds.has(itemId))) {
        normalized.push({
          ...merged,
          isManuscriptItem: false,
          _displayValidationExcluded: true,
          exclusionReason: topLevel?.reason || 'This OCR image/table fragment was not a distinct top-level manuscript display item.'
        });
        return;
      }
      seenItemIds.add(itemId);
      if (byTopLevel.has(topLevel.key)) {
        const existing = byTopLevel.get(topLevel.key);
        existing.citationOccurrences = mergeCitationOccurrences(existing.citationOccurrences, merged.citationOccurrences);
        normalized.push({
          ...merged,
          isManuscriptItem: false,
          _displayValidationExcluded: true,
          exclusionReason: 'Merged into the matching top-level display item.'
        });
        return;
      }
      const topLevelItem = {
        ...merged,
        label: topLevel.label,
        _displayTopLevelKey: topLevel.key
      };
      byTopLevel.set(topLevel.key, topLevelItem);
      normalized.push(topLevelItem);
    });
  return normalized;
}

export function readyDisplayItems(items = []) {
  return items.filter((item) => item.isManuscriptItem && !item._displayValidationExcluded);
}

export function excludedDisplayItems(items = [], kind = '') {
  return items.filter((item) => String(item.kind || '').toLowerCase() === kind && (item._displayValidationExcluded || !item.isManuscriptItem));
}
