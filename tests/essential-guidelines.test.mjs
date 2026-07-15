import assert from 'node:assert/strict';
import {
  buildEssentialGuidelineEvaluationRequest,
  normalizeEssentialGuidelineResults,
  pendingEssentialGuides
} from '../core/essential-guidelines.js';

const guides = [{
  id: 'ease-abstract-page',
  name: 'Abstract page',
  sourceLabel: 'EASE Essential guidelines',
  items: [
    { id: 'title', label: 'Informative title', requirement: 'Clear title.' },
    { id: 'keywords', label: 'Keywords', requirement: 'Keyword list when supplied.', optional: true }
  ]
}, {
  id: 'ease-declarations',
  name: 'Declarations',
  items: [
    { id: 'funding', label: 'Funding', requirement: 'Funding statement.' }
  ]
}];

const request = buildEssentialGuidelineEvaluationRequest({
  title: { text: 'Example manuscript', sourceBlockKey: 'block-1' }
}, guides);

assert.equal(request.guides.length, 2);
assert.equal(request.guides[0].items[0].label, 'Informative title');
assert.equal(request.guides[0].items[1].optional, true);

const pending = pendingEssentialGuides(guides);
assert.equal(pending[0].status, 'pending');
assert.equal(pending[0].summary.pending, 2);
assert.equal(pending[0].results[0].message, 'Waiting for LLM guideline evaluation.');

const evaluated = normalizeEssentialGuidelineResults({
  guides: [{
    id: 'ease-abstract-page',
    status: 'present',
    results: [
      {
        id: 'title',
        status: 'present',
        message: 'The title is clear.',
        sourceBlockKey: 'block-1',
        evidenceQuotes: [{ quote: 'Example manuscript', sourceBlockKey: 'block-1' }]
      },
      {
        id: 'keywords',
        status: 'optional',
        message: 'No keywords were supplied.',
        sourceBlockKey: '',
        evidenceQuotes: []
      }
    ]
  }, {
    id: 'ease-declarations',
    results: [{
      id: 'funding',
      status: 'warning',
      message: 'Funding support is mentioned, but details are limited.',
      sourceBlockKey: 'block-5',
      evidenceQuotes: [{ quote: 'Funding was provided by Example Council.', sourceBlockKey: 'block-5' }]
    }]
  }]
}, guides);

assert.equal(evaluated[0].status, 'present');
assert.equal(evaluated[0].summary.present, 1);
assert.equal(evaluated[0].summary.optional, 1);
assert.equal(evaluated[0].results[0].sourceBlockKey, 'block-1');
assert.equal(evaluated[0].results[0].evidenceQuote, 'Example manuscript');
assert.equal(evaluated[1].status, 'warning');
assert.equal(evaluated[1].summary.warning, 1);
assert.equal(evaluated[1].results[0].message, 'Funding support is mentioned, but details are limited.');
