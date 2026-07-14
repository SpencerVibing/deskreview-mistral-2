function text(value = '') {
  return String(value || '').trim();
}

function number(value = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

function array(value = []) {
  return Array.isArray(value) ? value : [];
}

export function normalizeReportingMatches(value = {}, catalog = []) {
  const catalogById = new Map(array(catalog).map((guide) => [guide.id, guide]));
  return {
    matches: array(value.matches)
      .map((match) => {
        const guidelineId = text(match.guidelineId);
        const guide = catalogById.get(guidelineId) || {};
        return {
          guidelineId,
          label: text(match.label) || text(guide.label) || guidelineId,
          rationale: text(match.rationale),
          confidence: number(match.confidence),
          sourceBlockKey: text(match.sourceBlockKey),
          anchorQuote: text(match.anchorQuote)
        };
      })
      .filter((match) => match.guidelineId && match.label)
      .sort((a, b) => b.confidence - a.confidence),
    warnings: array(value.warnings).map(text).filter(Boolean)
  };
}

export function buildGuidelineMatchRequest(annotation = {}, catalog = []) {
  return {
    documentAnnotation: annotation || {},
    catalog: array(catalog).map((guide) => ({
      id: text(guide.id),
      label: text(guide.label),
      description: text(guide.description),
      keywords: array(guide.keywords).map(text).filter(Boolean)
    })).filter((guide) => guide.id && guide.label)
  };
}
