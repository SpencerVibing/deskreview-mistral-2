import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptPrecomputedExampleSnapshot, normalizePrecomputedStatus } from '../core/precomputed-example.js';

assert.equal(normalizePrecomputedStatus('Present'), 'present');
assert.equal(normalizePrecomputedStatus('Optional'), 'optional');
assert.equal(normalizePrecomputedStatus('N/A'), 'na');
assert.equal(normalizePrecomputedStatus('skipped'), 'skipped');

const payload = JSON.parse(await readFile(new URL('../data/examples/precomputed/medRxivPDF.json', import.meta.url), 'utf8'));
const adapted = adaptPrecomputedExampleSnapshot(payload);
const exampleConfig = JSON.parse(await readFile(new URL('../data/example-manuscripts.json', import.meta.url), 'utf8'));

for (const example of exampleConfig.examples || []) {
  assert.equal(example.type, 'preprint');
  assert.ok(example.precomputedPath, `${example.id} should have a precomputed result path.`);
  assert.ok(example.pdfPath, `${example.id} should have a PDF path.`);
  const examplePayload = JSON.parse(await readFile(new URL(`..${example.precomputedPath}`, import.meta.url), 'utf8'));
  const exampleAdapted = adaptPrecomputedExampleSnapshot(examplePayload);
  assert.ok(exampleAdapted.pages.length > 0, `${example.id} should adapt into reader pages.`);
  assert.ok(exampleAdapted.essentialResults.length > 0, `${example.id} should adapt Essential results.`);
  assert.ok(exampleAdapted.semanticCounts.referenceCount > 0, `${example.id} should adapt reference counts.`);
}

assert.equal(adapted.essentialResults.length, 3);
assert.equal(adapted.essentialResults[0].id, 'ease-abstract-page');
assert.equal(adapted.reportingGuideResults.length, 5);
assert.equal(adapted.semanticCounts.authorCount, 22);
assert.equal(adapted.semanticCounts.referenceCount, 22);
assert.equal(adapted.pages.length, 24);
assert.equal(payload.ocr?.pages?.length, 24);
assert.deepEqual(
  adapted.pages
    .map((page, index) => (
      String(page.markdown || '').trim()
      || (page.blocks || []).some((block) => String(block.content || block.markdown || block.text || '').trim())
        ? null
        : index + 1
    ))
    .filter(Boolean),
  []
);
assert.ok(adapted.documentAnnotation.quoteAnchors.length > 5);

const precomputedBlocks = adapted.pages.flatMap((page) => page.blocks || []);
const titleBlock = adapted.sourceBlocks.find((block) => block.semanticKey === 'title');
assert.ok(titleBlock);
assert.match(
  titleBlock.text,
  /^## Combined Exercise Training vs Health Education for Older Adults with Hypertension: The HAEL Randomized Clinical Trial/m
);
assert.doesNotMatch(titleBlock.text, /^## Title page/m);

const tableBlocks = precomputedBlocks.filter((block) => block.type === 'table');
const figureBlocks = precomputedBlocks.filter((block) => block.type === 'figure' || block.type === 'image');
assert.equal(tableBlocks.length, 3);
assert.equal(figureBlocks.length, 1);
assert.deepEqual(adapted.displayResolver.items.filter((item) => item.kind === 'table').map((item) => item.sourceBlockKey), ['block-20-2', 'block-21-2', 'block-22-3']);
assert.deepEqual(adapted.displayResolver.items.filter((item) => item.kind === 'figure').map((item) => item.sourceBlockKey), ['block-19-2']);

const abstractGuide = adapted.essentialResults.find((guide) => guide.id === 'ease-abstract-page');
assert.ok(abstractGuide.results.length >= 10);
assert.ok(abstractGuide.results.some((item) => item.status === 'optional'));
assert.equal(abstractGuide.results.filter((item) => item.status === 'skipped').length, 2);
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
