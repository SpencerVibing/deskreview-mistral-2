import assert from 'node:assert/strict';
import {
  buildDocumentAnnotationRequest,
  normalizeDocumentAnnotation
} from '../core/document-annotation.js';

const normalized = normalizeDocumentAnnotation({
  title: { text: '  Example title ', sourceBlockKey: 'block-1', anchorQuote: 'Example' },
  frontMatter: {
    authors: [{ text: 'Ada Lovelace', sourceBlockKeys: ['block-2'] }],
    affiliations: [{ text: '', sourceBlockKeys: ['missing'] }],
    keywords: ['bad-shape']
  },
  abstract: { countedText: 'Abstract text', wordCount: '12', sourceBlockKeys: ['block-3'], warnings: [''] },
  references: {
    entries: [{
      rawReferenceText: 'Smith 2020.',
      sourceBlockKey: 'block-9',
      citationOccurrences: [{ citationText: 'Smith', contextQuote: 'Smith found...', blockKey: 'block-4' }]
    }]
  },
  displayItems: {
    items: [{ itemId: 't1', kind: 'table', label: 'Table 1', citationOccurrences: [] }]
  },
  quoteAnchors: [{ kind: 'abstract', label: 'Abstract', sourceBlockKey: 'block-3', quote: 'Abstract text' }],
  warnings: ['Needs review']
});

assert.equal(normalized.title.text, 'Example title');
assert.equal(normalized.frontMatter.authors.length, 1);
assert.equal(normalized.frontMatter.affiliations.length, 0);
assert.equal(normalized.abstract.wordCount, 12);
assert.equal(normalized.references.entries[0].number, 1);
assert.equal(normalized.displayItems.items[0].kind, 'table');
assert.equal(normalized.quoteAnchors.length, 1);

const request = buildDocumentAnnotationRequest({
  blocks: [
    { key: 'block-1', pageNumber: 1, type: 'heading', text: 'Title' },
    { key: '', pageNumber: 1, type: 'text', text: 'No key' },
    { key: 'empty', pageNumber: 1, type: 'text', text: '' }
  ],
  countResolver: { status: 'ready', result: { abstract: {} } },
  referenceResolver: { status: 'idle', result: { ignored: true } }
});

assert.equal(request.blocks.length, 1);
assert.deepEqual(request.resolverContext.countedText, { abstract: {} });
assert.equal(request.resolverContext.references, null);

const longRequest = buildDocumentAnnotationRequest({
  blocks: Array.from({ length: 260 }, (_, index) => ({
    key: `block-${index + 1}`,
    pageNumber: Math.ceil((index + 1) / 10),
    type: 'text',
    text: index === 259 ? 'Data availability statement' : `Block ${index + 1}`
  }))
});

assert.equal(longRequest.blocks.length, 220);
assert.equal(longRequest.blocks[0].blockKey, 'block-1');
assert.equal(longRequest.blocks.at(-1).blockKey, 'block-260');
