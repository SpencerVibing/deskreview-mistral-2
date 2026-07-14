function text(value = '') {
  return String(value || '').trim();
}

function array(value = []) {
  return Array.isArray(value) ? value : [];
}

function number(value = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function countWords(value = '') {
  return (text(value).match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length;
}

function normalizeLookup(value = '') {
  return text(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownHeading(level = 1, label = '') {
  return `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text(label) || 'Section'}`;
}

function sectionPages(section = {}) {
  const pages = array(section.pages).map(number).filter(Boolean);
  const startPage = number(section.startPage);
  if (startPage) pages.push(startPage);
  return [...new Set(pages)].sort((a, b) => a - b);
}

function firstPage(section = {}, fallback = 1) {
  return sectionPages(section)[0] || fallback;
}

function blockKeyFor(pageNumber = 1, blockIndex = 0) {
  return `block-${Math.max(0, Number(pageNumber || 1) - 1)}-${Math.max(0, Number(blockIndex || 0))}`;
}

function addBlock(pages, sourceBlocks, pageNumberValue, markdown, meta = {}) {
  const pageIndex = Math.max(0, Number(pageNumberValue || 1) - 1);
  while (pages.length <= pageIndex) {
    pages.push({ index: pages.length, markdown: '', blocks: [] });
  }
  const page = pages[pageIndex];
  const blockIndex = page.blocks.length;
  const block = {
    type: meta.type || 'text',
    markdown: text(markdown),
    sourcePages: array(meta.sourcePages).map(number).filter(Boolean),
    precomputedLabel: text(meta.label),
    precomputedKey: text(meta.key)
  };
  page.blocks.push(block);
  const sourceBlock = {
    key: blockKeyFor(pageNumberValue, blockIndex),
    pageNumber: pageIndex + 1,
    label: text(meta.label),
    semanticKey: text(meta.key),
    sectionHint: text(meta.sectionHint || meta.label).toLowerCase(),
    text: text(markdown)
  };
  sourceBlocks.push(sourceBlock);
  return sourceBlock;
}

function sectionMarkdown(label = '', value = '') {
  const body = text(value);
  return `${markdownHeading(1, label)}${body ? `\n\n${body}` : ''}`;
}

function candidateTitle(snapshot = {}, titleText = '') {
  const normalizedTitleText = normalizeLookup(titleText);
  const candidates = [
    snapshot.openAlexSimilarAbstracts?.input?.title,
    snapshot.semanticScholarSimilarAbstracts?.input?.title,
    snapshot.openAlexSimilarAbstracts?.results?.[0]?.title,
    snapshot.openAlexAuthors?.authors?.[0]?.openAlexCandidate?.recentWorks?.[0]?.title
  ].map(text).filter(Boolean);
  return candidates.find((candidate) => normalizedTitleText.includes(normalizeLookup(candidate))) || '';
}

function titleHeading(snapshot = {}, section = {}) {
  const titleText = text(section.text);
  const lines = titleText.split(/\r?\n/).map(text).filter(Boolean);
  const fromSnapshot = candidateTitle(snapshot, titleText);
  if (fromSnapshot) return fromSnapshot;
  if (lines.length > 1 && /^[a-z(]/.test(lines[1])) return `${lines[0]} ${lines[1]}`;
  return lines[0] || text(section.startQuote) || text(section.label) || 'Title';
}

function withoutLeadingTitle(value = '', title = '') {
  const lines = text(value).split(/\r?\n/).map(text).filter(Boolean);
  const titleKey = normalizeLookup(title);
  if (!lines.length || !titleKey) return text(value);
  const consumed = [];
  for (let index = 0; index < Math.min(8, lines.length); index += 1) {
    consumed.push(lines[index]);
    const candidateKey = normalizeLookup(consumed.join(' '));
    if (candidateKey === titleKey || candidateKey.startsWith(titleKey)) {
      return lines.slice(index + 1).join('\n');
    }
    if (!titleKey.startsWith(candidateKey)) break;
  }
  return text(value);
}

function displayItemMarkdown(item = {}, label = '') {
  const title = text(item.title);
  const caption = text(item.captionQuote || item.rawText);
  const lines = [
    title && normalizeLookup(title) !== normalizeLookup(label) ? `**${title}**` : '',
    caption && normalizeLookup(caption) !== normalizeLookup(`${label} ${title}`) ? caption : ''
  ].filter(Boolean);
  return `${markdownHeading(2, label)}${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`;
}

function buildSourcePages(snapshot = {}) {
  const documentMap = snapshot.documentMap || {};
  const pages = [];
  const sourceBlocks = [];
  const sections = [
    ['title', 'Title', documentMap.title],
    ['abstract', 'Abstract', documentMap.abstract],
    ['introduction', 'Introduction', documentMap.introduction],
    ['methods', 'Methods', documentMap.methods],
    ['results', 'Results', documentMap.results],
    ['discussion', 'Discussion', documentMap.discussion],
    ['conclusions', 'Conclusions', documentMap.conclusions],
    ['declarations', text(documentMap.declarations?.label) || 'Declarations', documentMap.declarations],
    ['references', 'References', documentMap.references]
  ];
  sections.forEach(([key, fallbackLabel, section]) => {
    if (!section || typeof section !== 'object') return;
    const label = key === 'title' ? titleHeading(snapshot, section) : text(section.label) || fallbackLabel;
    const sourceLabel = text(section.label) || fallbackLabel;
    const sectionBody = key === 'title'
      ? withoutLeadingTitle(section.text || '', label)
      : section.text || [section.startQuote, section.endQuote].filter(Boolean).join('\n\n');
    const markdown = sectionMarkdown(label, sectionBody);
    if (!text(markdown).replace(/^#+\s+\S+/, '').trim()) return;
    addBlock(pages, sourceBlocks, firstPage(section), markdown, {
      key,
      label: sourceLabel,
      sectionHint: label,
      sourcePages: sectionPages(section)
    });
  });
  array(documentMap.figures).forEach((figure, index) => {
    const label = text(figure.label) || `Figure ${index + 1}`;
    addBlock(pages, sourceBlocks, firstPage(figure, 1), displayItemMarkdown(figure, label), {
      key: `figure-${index + 1}`,
      label,
      sectionHint: 'figures',
      type: 'figure',
      sourcePages: sectionPages(figure)
    });
  });
  array(documentMap.tables).forEach((table, index) => {
    const label = text(table.label) || `Table ${index + 1}`;
    addBlock(pages, sourceBlocks, firstPage(table, 1), displayItemMarkdown(table, label), {
      key: `table-${index + 1}`,
      label,
      sectionHint: 'tables',
      type: 'table',
      sourcePages: sectionPages(table)
    });
  });
  const maxPage = Math.max(
    pages.length,
    ...array(snapshot.pdfOutline).map((entry) => number(entry.page)),
    ...sourceBlocks.map((block) => block.pageNumber),
    1
  );
  while (pages.length < maxPage) {
    pages.push({ index: pages.length, markdown: '', blocks: [] });
  }
  return { pages, sourceBlocks };
}

function sourceBlockBySemanticKey(sourceBlocks = [], key = '') {
  const normalized = text(key).toLowerCase();
  return sourceBlocks.find((block) => block.semanticKey.toLowerCase() === normalized) || null;
}

function fallbackBlockForSection(sourceBlocks = [], section = '', guideName = '') {
  const haystack = `${section} ${guideName}`.toLowerCase();
  const candidates = [
    [/title|abstract|front|author|keyword/, 'abstract'],
    [/method|intervention|random|trial|statistical|protocol|open science|registration|data sharing/, 'methods'],
    [/result|outcome|harms|participant flow|baseline/, 'results'],
    [/discussion|limitation|interpretation/, 'discussion'],
    [/declaration|ethic|funding|conflict|interest|consent|data availability|patient/, 'declarations'],
    [/reference|citation/, 'references']
  ];
  const matched = candidates.find(([pattern]) => pattern.test(haystack));
  return matched
    ? sourceBlockBySemanticKey(sourceBlocks, matched[1])
    : (sourceBlocks[0] || null);
}

function quoteSourceBlockKey(quote = '', sourceBlocks = [], section = '', guideName = '') {
  const normalized = normalizeLookup(quote);
  if (normalized) {
    const exact = sourceBlocks.find((block) => normalizeLookup(block.text).includes(normalized));
    if (exact) return exact.key;
    const shortNeedle = normalized.slice(0, 90);
    const partial = shortNeedle.length > 24
      ? sourceBlocks.find((block) => normalizeLookup(block.text).includes(shortNeedle))
      : null;
    if (partial) return partial.key;
  }
  return fallbackBlockForSection(sourceBlocks, section, guideName)?.key || '';
}

export function normalizePrecomputedStatus(value = '') {
  const normalized = text(value).toLowerCase();
  if (['present', 'yes', 'reported', 'complete'].includes(normalized)) return 'present';
  if (['warning', 'partial', 'unclear', 'maybe'].includes(normalized)) return 'warning';
  if (['absent', 'no', 'missing'].includes(normalized)) return 'absent';
  if (['optional', 'encouraged'].includes(normalized)) return 'optional';
  if (normalized === 'skipped') return 'skipped';
  if (['n/a', 'na', 'not applicable'].includes(normalized)) return 'na';
  if (['pending', 'running'].includes(normalized)) return 'pending';
  return normalized || 'warning';
}

function guideSummary(results = []) {
  return array(results).reduce((summary, item) => {
    const status = normalizePrecomputedStatus(item.status);
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, { present: 0, warning: 0, absent: 0, optional: 0, skipped: 0, na: 0, pending: 0 });
}

function guideStatus(summary = {}) {
  if (Number(summary.absent || 0) > 0) return 'absent';
  if (Number(summary.warning || 0) > 0) return 'warning';
  if (Number(summary.pending || 0) > 0) return 'pending';
  return 'present';
}

function essentialGuideId(guideId = '') {
  const normalized = text(guideId).toLowerCase();
  if (normalized === 'ease_front_matter') return 'ease-abstract-page';
  if (normalized === 'ease_imrad') return 'ease-imrad';
  if (normalized === 'ease_declarations') return 'ease-declarations';
  return text(guideId);
}

function adaptGuide(guide = {}, sourceBlocks = []) {
  const guideName = text(guide.guideName || guide.name);
  const results = array(guide.analysis).map((item, index) => {
    const quotes = array(item.quotes).map(text).filter(Boolean);
    const section = text(item.section);
    const evidenceQuotes = quotes.map((quote) => ({
      quote,
      sourceBlockKey: quoteSourceBlockKey(quote, sourceBlocks, section, guideName)
    }));
    const sourceBlockKey = evidenceQuotes.find((entry) => entry.sourceBlockKey)?.sourceBlockKey
      || quoteSourceBlockKey('', sourceBlocks, section, guideName);
    return {
      id: text(item.item) || `${text(guide.guideId || 'guide')}-${index + 1}`,
      label: text(item.item_name || item.item_question || item.item) || `Item ${index + 1}`,
      section,
      requirement: text(item.item_question || item.item_question_background),
      background: text(item.item_question_background),
      status: normalizePrecomputedStatus(item.reported_raw || item.reported),
      message: text(item.comment),
      evidenceQuote: evidenceQuotes[0]?.quote || '',
      evidenceQuotes,
      sourceBlockKey
    };
  });
  const summary = guideSummary(results);
  return {
    id: text(guide.guideId),
    name: guideName || text(guide.guideId) || 'Guide',
    description: text(guide.guideDescription || guide.description),
    sourceLabel: text(guide.source) === 'matched' ? 'Matched guideline' : 'EASE Essential guidelines',
    status: guideStatus(summary),
    summary,
    results
  };
}

function metadataItemsFromTitleBlock(snapshot = {}, sourceBlocks = []) {
  const documentMap = snapshot.documentMap || {};
  const titleBlock = sourceBlockBySemanticKey(sourceBlocks, 'title');
  const structuredAuthors = array(snapshot.openAlexAuthors?.authors).length
    ? array(snapshot.openAlexAuthors.authors)
    : array(snapshot.semanticScholarAuthors?.authors);
  if (structuredAuthors.length) {
    const authors = structuredAuthors
      .map((author) => ({ text: text(author.name), sourceBlockKeys: titleBlock ? [titleBlock.key] : [] }))
      .filter((author) => author.text);
    const seenAffiliations = new Set();
    const affiliations = structuredAuthors
      .flatMap((author) => text(author.affiliation).split(/;\s*/))
      .map(text)
      .filter(Boolean)
      .filter((affiliation) => {
        const key = normalizeLookup(affiliation);
        if (seenAffiliations.has(key)) return false;
        seenAffiliations.add(key);
        return true;
      })
      .map((affiliation) => ({ text: affiliation, sourceBlockKeys: titleBlock ? [titleBlock.key] : [] }));
    return { authors, affiliations, keywords: [] };
  }
  const titleText = text(documentMap.title?.text);
  const lines = titleText.split(/\r?\n/).map(text).filter(Boolean);
  const affiliationStart = lines.findIndex((line) => /^affiliations:?$/i.test(line));
  const correspondingStart = lines.findIndex((line) => /^corresponding author:?$/i.test(line));
  const authorLines = lines.slice(1, affiliationStart > 1 ? affiliationStart : Math.min(lines.length, 8));
  const affiliationLines = affiliationStart >= 0
    ? lines.slice(affiliationStart + 1, correspondingStart > affiliationStart ? correspondingStart : affiliationStart + 12)
    : [];
  return {
    authors: authorLines.length ? [{ text: authorLines.join(' '), sourceBlockKeys: titleBlock ? [titleBlock.key] : [] }] : [],
    affiliations: affiliationLines.map((line) => ({ text: line, sourceBlockKeys: titleBlock ? [titleBlock.key] : [] })),
    keywords: []
  };
}

function documentAnnotation(snapshot = {}, sourceBlocks = []) {
  const documentMap = snapshot.documentMap || {};
  const titleBlock = sourceBlockBySemanticKey(sourceBlocks, 'title');
  const abstractBlock = sourceBlockBySemanticKey(sourceBlocks, 'abstract');
  const metadata = metadataItemsFromTitleBlock(snapshot, sourceBlocks);
  const articleSections = ['introduction', 'methods', 'results', 'discussion', 'conclusions', 'declarations']
    .map((key) => {
      const section = documentMap[key];
      const block = sourceBlockBySemanticKey(sourceBlocks, key);
      return section && block ? {
        title: text(section.label) || key,
        countedText: text(section.text),
        sourceBlockKeys: [block.key]
      } : null;
    })
    .filter(Boolean);
  const referencesBlock = sourceBlockBySemanticKey(sourceBlocks, 'references');
  const displayItems = [
    ...array(documentMap.tables).map((item, index) => ({ ...item, itemId: `table-${index + 1}`, kind: 'table' })),
    ...array(documentMap.figures).map((item, index) => ({ ...item, itemId: `figure-${index + 1}`, kind: 'figure' }))
  ];
  const quoteAnchors = sourceBlocks.map((block) => ({
    kind: block.semanticKey || 'section',
    label: block.label,
    sourceBlockKey: block.key,
    quote: text(block.text).slice(0, 260)
  })).filter((item) => item.quote);
  return {
    title: {
      text: text(documentMap.title?.text).split(/\r?\n/).map(text).filter(Boolean)[0] || text(documentMap.title?.label),
      sourceBlockKey: titleBlock?.key || '',
      anchorQuote: text(documentMap.title?.startQuote)
    },
    frontMatter: metadata,
    abstract: {
      countedText: text(documentMap.metrics?.wordCounts?.abstract?.countedText || documentMap.abstract?.text),
      wordCount: number(documentMap.metrics?.wordCounts?.abstract?.count) || countWords(documentMap.abstract?.text),
      sourceBlockKeys: abstractBlock ? [abstractBlock.key] : [],
      warnings: array(documentMap.abstract?.warnings).map(text).filter(Boolean)
    },
    article: {
      wordCount: articleSections.reduce((sum, section) => sum + countWords(section.countedText), 0),
      sections: articleSections,
      warnings: array(documentMap.warnings).map(text).filter(Boolean)
    },
    references: {
      entries: array(snapshot.referenceChecks?.references).map((entry, index) => ({
        number: number(entry.number || entry.index) || index + 1,
        rawReferenceText: text(entry.rawReferenceText || entry.rawText || entry.reference || entry.title),
        sourceBlockKey: referencesBlock?.key || '',
        bibliographyAnchorQuote: text(entry.bibliographyAnchorQuote || entry.rawReferenceText || entry.rawText || entry.reference).slice(0, 180),
        citationOccurrences: []
      })).filter((entry) => entry.rawReferenceText),
      warnings: []
    },
    displayItems: {
      items: displayItems.map((item) => {
        const block = sourceBlockBySemanticKey(sourceBlocks, item.itemId);
        return {
          itemId: text(item.itemId),
          kind: item.kind === 'figure' ? 'figure' : 'table',
          label: text(item.label),
          sourceBlockKey: block?.key || '',
          anchorQuote: text(item.captionQuote || item.title || item.label),
          citationOccurrences: []
        };
      }),
      warnings: []
    },
    quoteAnchors,
    warnings: array(documentMap.warnings).map(text).filter(Boolean)
  };
}

function countResolverResult(annotation = {}) {
  return {
    abstract: {
      label: 'Abstract',
      countedText: text(annotation.abstract?.countedText),
      wordCount: number(annotation.abstract?.wordCount),
      excludedText: [],
      warnings: array(annotation.abstract?.warnings)
    },
    article: {
      sections: array(annotation.article?.sections),
      excludedText: [],
      warnings: array(annotation.article?.warnings)
    },
    metadata: {
      authors: array(annotation.frontMatter?.authors),
      affiliations: array(annotation.frontMatter?.affiliations),
      keywords: array(annotation.frontMatter?.keywords),
      warnings: []
    },
    warnings: array(annotation.warnings)
  };
}

function referencesDetail(snapshot = {}, sourceBlocks = []) {
  const referencesBlock = sourceBlockBySemanticKey(sourceBlocks, 'references');
  const references = array(snapshot.referenceChecks?.references);
  return {
    kind: 'references',
    detail: {
      count: number(snapshot.referenceChecks?.summary?.totalReferences) || references.length,
      entries: references.map((entry, index) => ({
        number: number(entry.number || entry.index) || index + 1,
        rawText: text(entry.rawReferenceText || entry.rawText || entry.reference || entry.title),
        sourceBlockKey: referencesBlock?.key || '',
        bibliographyAnchorQuote: text(entry.bibliographyAnchorQuote || entry.rawReferenceText || entry.rawText || entry.reference).slice(0, 180),
        citationOccurrences: []
      })).filter((entry) => entry.rawText),
      warnings: []
    }
  };
}

function displayResolverResult(snapshot = {}, sourceBlocks = []) {
  const documentMap = snapshot.documentMap || {};
  const displayItems = [
    ...array(documentMap.tables).map((item, index) => ({ ...item, itemId: `table-${index + 1}`, kind: 'table' })),
    ...array(documentMap.figures).map((item, index) => ({ ...item, itemId: `figure-${index + 1}`, kind: 'figure' }))
  ];
  return {
    items: displayItems.map((item) => {
      const block = sourceBlockBySemanticKey(sourceBlocks, item.itemId);
      return {
        itemId: text(item.itemId),
        kind: item.kind === 'figure' ? 'figure' : 'table',
        isManuscriptItem: true,
        label: text(item.label),
        sourceBlockKey: block?.key || '',
        anchorQuote: text(item.captionQuote || item.title || item.label),
        citationOccurrences: []
      };
    }),
    warnings: []
  };
}

export function adaptPrecomputedExampleSnapshot(snapshot = {}) {
  const { pages, sourceBlocks } = buildSourcePages(snapshot);
  const annotation = documentAnnotation(snapshot, sourceBlocks);
  const countResult = countResolverResult(annotation);
  const essentialIds = new Set(['ease_front_matter', 'ease_IMRaD', 'ease_declarations']);
  const adaptedGuides = array(snapshot.guides).map((guide) => adaptGuide(guide, sourceBlocks));
  const essentialResults = adaptedGuides
    .filter((guide) => essentialIds.has(guide.id))
    .map((guide) => ({ ...guide, id: essentialGuideId(guide.id), sourceLabel: 'EASE Essential guidelines' }));
  const reportingGuideResults = adaptedGuides
    .filter((guide) => !essentialIds.has(guide.id))
    .map((guide) => ({ ...guide, sourceLabel: 'Matched guideline' }));
  const semanticCounts = {
    abstractWordCount: number(snapshot.documentMap?.metrics?.wordCounts?.abstract?.count) || countWords(annotation.abstract.countedText),
    articleWordCount: number(annotation.article.wordCount),
    referenceCount: number(snapshot.referenceChecks?.summary?.totalReferences) || array(annotation.references.entries).length,
    authorCount: array(annotation.frontMatter.authors).length,
    affiliationCount: array(annotation.frontMatter.affiliations).length,
    keywordCount: array(annotation.frontMatter.keywords).length,
    tableCount: array(snapshot.documentMap?.tables).length,
    figureCount: array(snapshot.documentMap?.figures).length
  };
  return {
    pages,
    sourceBlocks,
    semanticCounts,
    countResolver: countResult,
    referenceResolver: {
      entries: array(annotation.references.entries).map((entry) => ({
        number: entry.number,
        rawReferenceText: entry.rawReferenceText,
        sourceBlockKey: entry.sourceBlockKey,
        bibliographyAnchorQuote: entry.bibliographyAnchorQuote,
        citationMatchers: []
      })),
      warnings: []
    },
    displayResolver: displayResolverResult(snapshot, sourceBlocks),
    documentAnnotation: annotation,
    essentialResults,
    reportingGuideResults,
    reportingMatches: {
      matches: reportingGuideResults.map((guide) => ({
        guidelineId: guide.id,
        label: guide.name,
        rationale: guide.description,
        confidence: 1,
        sourceBlockKey: guide.results.find((item) => item.sourceBlockKey)?.sourceBlockKey || '',
        anchorQuote: guide.results.find((item) => item.evidenceQuote)?.evidenceQuote || ''
      })),
      warnings: []
    },
    detailCache: {
      references: referencesDetail(snapshot, sourceBlocks)
    }
  };
}
