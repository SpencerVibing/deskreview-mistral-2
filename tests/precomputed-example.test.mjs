import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptPrecomputedExampleSnapshot, normalizePrecomputedStatus } from '../core/precomputed-example.js';

assert.equal(normalizePrecomputedStatus('Present'), 'present');
assert.equal(normalizePrecomputedStatus('Optional'), 'optional');
assert.equal(normalizePrecomputedStatus('N/A'), 'na');
assert.equal(normalizePrecomputedStatus('skipped'), 'na');

const payload = JSON.parse(await readFile(new URL('../data/examples/precomputed/medRxivPDF.json', import.meta.url), 'utf8'));
const adapted = adaptPrecomputedExampleSnapshot(payload);

assert.equal(adapted.essentialResults.length, 3);
assert.equal(adapted.essentialResults[0].id, 'ease-abstract-page');
assert.equal(adapted.reportingGuideResults.length, 5);
assert.equal(adapted.semanticCounts.authorCount, 22);
assert.equal(adapted.semanticCounts.referenceCount, 22);
assert.ok(adapted.pages.length >= 20);
assert.ok(adapted.documentAnnotation.quoteAnchors.length > 5);

const abstractGuide = adapted.essentialResults.find((guide) => guide.id === 'ease-abstract-page');
assert.ok(abstractGuide.results.length >= 10);
assert.ok(abstractGuide.results.some((item) => item.status === 'optional'));
assert.equal(abstractGuide.results.filter((item) => item.status === 'skipped').length, 0);
assert.ok(abstractGuide.results.some((item) => item.evidenceQuotes?.[0]?.sourceBlockKey));

const consort = adapted.reportingGuideResults.find((guide) => guide.id === 'consort');
assert.ok(consort);
assert.ok(consort.results.length >= 40);
assert.ok(consort.results.some((item) => item.evidenceQuotes.length > 1));
assert.ok(consort.results.some((item) => item.sourceBlockKey));

assert.equal(adapted.countResolver.metadata.authors.length, 22);
assert.equal(adapted.referenceResolver.entries.length, 22);
assert.equal(adapted.displayResolver.items.filter((item) => item.kind === 'table').length, 3);
assert.equal(adapted.displayResolver.items.filter((item) => item.kind === 'figure').length, 1);
