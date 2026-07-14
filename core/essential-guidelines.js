function text(value = '') {
  return String(value || '').trim();
}

function array(value = []) {
  return Array.isArray(value) ? value : [];
}

function firstSourceKey(keys = []) {
  return array(keys).map(text).find(Boolean) || '';
}

function result(status = 'warning', evidence = {}) {
  return {
    status,
    evidenceQuote: text(evidence.evidenceQuote),
    sourceBlockKey: text(evidence.sourceBlockKey),
    message: text(evidence.message)
  };
}

function keywords(value = []) {
  return array(value).map((item) => text(item).toLowerCase()).filter(Boolean);
}

function textIncludesAny(value = '', terms = []) {
  const haystack = text(value).toLowerCase();
  return keywords(terms).some((term) => haystack.includes(term));
}

function sectionEvidence(annotation = {}, terms = []) {
  const sections = array(annotation.article?.sections);
  for (const section of sections) {
    const title = text(section.title);
    const countedText = text(section.countedText);
    if (textIncludesAny(`${title}\n${countedText}`, terms)) {
      return {
        evidenceQuote: (title || countedText).slice(0, 220),
        sourceBlockKey: firstSourceKey(section.sourceBlockKeys)
      };
    }
  }
  const anchors = array(annotation.quoteAnchors);
  for (const anchor of anchors) {
    if (textIncludesAny(`${anchor.kind}\n${anchor.label}\n${anchor.quote}`, terms)) {
      return {
        evidenceQuote: text(anchor.quote).slice(0, 220),
        sourceBlockKey: text(anchor.sourceBlockKey)
      };
    }
  }
  return null;
}

function evaluateItem(item = {}, annotation = {}) {
  const type = text(item.type);
  if (type === 'title') {
    const title = text(annotation.title?.text);
    return title
      ? result('present', { evidenceQuote: title, sourceBlockKey: annotation.title?.sourceBlockKey, message: 'Title annotated.' })
      : result('absent', { message: 'No title was returned in the document annotation.' });
  }
  if (type === 'authors') {
    const authors = array(annotation.frontMatter?.authors);
    const affiliations = array(annotation.frontMatter?.affiliations);
    if (authors.length && affiliations.length) {
      return result('present', {
        evidenceQuote: authors.map((item) => item.text).filter(Boolean).slice(0, 3).join('; '),
        sourceBlockKey: firstSourceKey(authors[0]?.sourceBlockKeys),
        message: `${authors.length} author${authors.length === 1 ? '' : 's'} and ${affiliations.length} affiliation${affiliations.length === 1 ? '' : 's'} annotated.`
      });
    }
    if (authors.length) {
      return result('warning', {
        evidenceQuote: authors.map((item) => item.text).filter(Boolean).slice(0, 3).join('; '),
        sourceBlockKey: firstSourceKey(authors[0]?.sourceBlockKeys),
        message: 'Authors were annotated, but affiliations were not returned.'
      });
    }
    return result('absent', { message: 'No authors were returned in the document annotation.' });
  }
  if (type === 'abstract') {
    const abstract = text(annotation.abstract?.countedText);
    return abstract
      ? result('present', {
        evidenceQuote: abstract.slice(0, 220),
        sourceBlockKey: firstSourceKey(annotation.abstract?.sourceBlockKeys),
        message: `${Number(annotation.abstract?.wordCount || 0)} abstract words annotated.`
      })
      : result('absent', { message: 'No abstract text was returned in the document annotation.' });
  }
  if (type === 'keywords') {
    const keywords = array(annotation.frontMatter?.keywords);
    return keywords.length
      ? result('present', {
        evidenceQuote: keywords.map((item) => item.text).filter(Boolean).join(', '),
        sourceBlockKey: firstSourceKey(keywords[0]?.sourceBlockKeys),
        message: `${keywords.length} keyword${keywords.length === 1 ? '' : 's'} annotated.`
      })
      : result('na', { message: 'No keyword list was returned in the document annotation.' });
  }
  if (type === 'article') {
    const sections = array(annotation.article?.sections);
    if (sections.length || Number(annotation.article?.wordCount || 0) > 0) {
      const first = sections[0] || {};
      return result('present', {
        evidenceQuote: text(first.countedText || first.title).slice(0, 220),
        sourceBlockKey: firstSourceKey(first.sourceBlockKeys),
        message: `${sections.length} article section${sections.length === 1 ? '' : 's'} annotated.`
      });
    }
    return result('absent', { message: 'No main article sections were returned in the document annotation.' });
  }
  if (type === 'references') {
    const entries = array(annotation.references?.entries);
    return entries.length
      ? result('present', {
        evidenceQuote: entries[0].bibliographyAnchorQuote || entries[0].rawReferenceText,
        sourceBlockKey: entries[0].sourceBlockKey,
        message: `${entries.length} reference${entries.length === 1 ? '' : 's'} annotated.`
      })
      : result('warning', { message: 'No reference entries were returned in the document annotation.' });
  }
  if (type === 'displayItems') {
    const items = array(annotation.displayItems?.items);
    return items.length
      ? result('present', {
        evidenceQuote: items[0].anchorQuote || items[0].label,
        sourceBlockKey: items[0].sourceBlockKey,
        message: `${items.length} table/figure item${items.length === 1 ? '' : 's'} annotated.`
      })
      : result('na', { message: 'No tables or figures were returned in the document annotation.' });
  }
  if (type === 'quoteAnchors') {
    const anchors = array(annotation.quoteAnchors);
    return anchors.length
      ? result('present', {
        evidenceQuote: anchors[0].quote,
        sourceBlockKey: anchors[0].sourceBlockKey,
        message: `${anchors.length} source quote anchor${anchors.length === 1 ? '' : 's'} available.`
      })
      : result('warning', { message: 'No source quote anchors were returned in the document annotation.' });
  }
  if (type === 'sectionKeywords') {
    const evidence = sectionEvidence(annotation, item.keywords);
    return evidence
      ? result('present', {
        ...evidence,
        message: `${text(item.label || 'Section')} evidence was found in the annotated article structure.`
      })
      : result('absent', {
        message: `${text(item.label || 'Required section')} was not found in the annotated article structure.`
      });
  }
  if (type === 'statementKeywords') {
    const evidence = sectionEvidence(annotation, item.keywords);
    return evidence
      ? result('present', {
        ...evidence,
        message: `${text(item.label || 'Statement')} evidence was found in the annotated article structure.`
      })
      : result('warning', {
        message: `${text(item.label || 'Statement')} was not confirmed by the document annotation.`
      });
  }
  return result('warning', { message: 'This guideline item is not supported yet.' });
}

function summary(items = []) {
  return items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { present: 0, warning: 0, absent: 0, na: 0 });
}

export function evaluateEssentialGuides(guides = [], annotation = null) {
  if (!annotation) {
    return array(guides).map((guide) => ({
      ...guide,
      status: 'pending',
      summary: { present: 0, warning: 0, absent: 0, na: 0 },
      results: array(guide.items).map((item) => ({
        ...item,
        status: 'pending',
        evidenceQuote: '',
        sourceBlockKey: '',
        message: 'Waiting for document annotation.'
      }))
    }));
  }
  return array(guides).map((guide) => {
    const results = array(guide.items).map((item) => ({
      ...item,
      ...evaluateItem(item, annotation)
    }));
    const totals = summary(results);
    const status = totals.absent ? 'absent' : (totals.warning ? 'warning' : 'present');
    return { ...guide, status, summary: totals, results };
  });
}
