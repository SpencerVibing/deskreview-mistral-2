function text(value = '') {
  return String(value || '').trim();
}

function number(value = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function array(value = []) {
  return Array.isArray(value) ? value : [];
}

function sourceKeys(value = []) {
  return array(value).map((entry) => text(entry)).filter(Boolean);
}

function anchor(value = {}) {
  return {
    sourceBlockKey: text(value.sourceBlockKey),
    anchorQuote: text(value.anchorQuote)
  };
}

function isLowValueAnnotationBlock(block = {}) {
  const type = text(block.type).toLowerCase();
  if (['header', 'footer', 'equation', 'image'].includes(type)) return true;
  return false;
}

function isHighValueAnnotationBlock(block = {}) {
  const type = text(block.type).toLowerCase();
  const value = text(block.text || block.plainText);
  if (['title', 'caption', 'table'].includes(type)) return true;
  return /abstract|introduction|method|result|discussion|conclusion|acknowledg|reference|funding|conflict|competing|ethic|consent|data availability|author contribution|declaration|keyword/i.test(value);
}

function annotationBlocks(blocks = [], limit = 120) {
  const normalized = array(blocks)
    .filter((block) => !isLowValueAnnotationBlock(block))
    .map((block) => ({
      blockKey: text(block.key || block.blockKey),
      pageNumber: number(block.pageNumber),
      type: text(block.type),
      text: text(block.text || block.plainText).slice(0, 900)
    }))
    .filter((block) => block.blockKey && block.text);
  if (normalized.length <= limit) return normalized;
  const highValue = normalized.filter(isHighValueAnnotationBlock);
  const selected = [
    ...normalized.slice(0, 70),
    ...highValue,
    ...normalized.slice(-40)
  ].slice(0, limit);
  const seen = new Set();
  return selected.filter((block) => {
    if (seen.has(block.blockKey)) return false;
    seen.add(block.blockKey);
    return true;
  });
}

function textItem(value = {}) {
  return {
    text: text(value.text),
    sourceBlockKeys: sourceKeys(value.sourceBlockKeys)
  };
}

function citation(value = {}) {
  return {
    citationText: text(value.citationText),
    contextQuote: text(value.contextQuote),
    blockKey: text(value.blockKey)
  };
}

export function normalizeDocumentAnnotation(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    title: {
      text: text(source.title?.text),
      ...anchor(source.title)
    },
    frontMatter: {
      authors: array(source.frontMatter?.authors).map(textItem).filter((item) => item.text),
      affiliations: array(source.frontMatter?.affiliations).map(textItem).filter((item) => item.text),
      keywords: array(source.frontMatter?.keywords).map(textItem).filter((item) => item.text)
    },
    abstract: {
      countedText: text(source.abstract?.countedText),
      wordCount: number(source.abstract?.wordCount),
      sourceBlockKeys: sourceKeys(source.abstract?.sourceBlockKeys),
      warnings: array(source.abstract?.warnings).map(text).filter(Boolean)
    },
    article: {
      wordCount: number(source.article?.wordCount),
      sections: array(source.article?.sections)
        .map((section) => ({
          title: text(section.title),
          countedText: text(section.countedText),
          sourceBlockKeys: sourceKeys(section.sourceBlockKeys)
        }))
        .filter((section) => section.title || section.countedText || section.sourceBlockKeys.length),
      warnings: array(source.article?.warnings).map(text).filter(Boolean)
    },
    references: {
      entries: array(source.references?.entries)
        .map((entry, index) => ({
          number: number(entry.number) || index + 1,
          rawReferenceText: text(entry.rawReferenceText),
          sourceBlockKey: text(entry.sourceBlockKey),
          bibliographyAnchorQuote: text(entry.bibliographyAnchorQuote),
          citationOccurrences: array(entry.citationOccurrences).map(citation).filter((item) => item.citationText || item.contextQuote)
        }))
        .filter((entry) => entry.rawReferenceText),
      warnings: array(source.references?.warnings).map(text).filter(Boolean)
    },
    displayItems: {
      items: array(source.displayItems?.items)
        .map((item) => ({
          itemId: text(item.itemId),
          kind: text(item.kind) === 'figure' ? 'figure' : 'table',
          label: text(item.label),
          sourceBlockKey: text(item.sourceBlockKey),
          anchorQuote: text(item.anchorQuote),
          citationOccurrences: array(item.citationOccurrences).map(citation).filter((entry) => entry.citationText || entry.contextQuote)
        }))
        .filter((item) => item.itemId || item.label || item.anchorQuote),
      warnings: array(source.displayItems?.warnings).map(text).filter(Boolean)
    },
    quoteAnchors: array(source.quoteAnchors)
      .map((item) => ({
        kind: text(item.kind),
        label: text(item.label),
        sourceBlockKey: text(item.sourceBlockKey),
        quote: text(item.quote)
      }))
      .filter((item) => item.sourceBlockKey && item.quote),
    warnings: array(source.warnings).map(text).filter(Boolean)
  };
}

export function buildDocumentAnnotationRequest({ blocks = [], countResolver = null, referenceResolver = null, displayResolver = null } = {}) {
  return {
    blocks: annotationBlocks(blocks),
    resolverContext: {
      countedText: countResolver?.status === 'ready' ? countResolver.result || null : null,
      references: referenceResolver?.status === 'ready' ? referenceResolver.result || null : null,
      displayItems: displayResolver?.status === 'ready' ? displayResolver.result || null : null
    }
  };
}
