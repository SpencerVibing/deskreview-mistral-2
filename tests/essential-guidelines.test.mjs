import assert from 'node:assert/strict';
import { evaluateEssentialGuides } from '../core/essential-guidelines.js';

const guides = [{
  id: 'ease-essential',
  name: 'EASE Essentials',
  items: [
    { id: 'title', type: 'title' },
    { id: 'authors', type: 'authors' },
    { id: 'references', type: 'references' },
    { id: 'keywords', type: 'keywords' }
  ]
}];

const pending = evaluateEssentialGuides(guides, null);
assert.equal(pending[0].status, 'pending');
assert.equal(pending[0].results[0].message, 'Waiting for document annotation.');

const evaluated = evaluateEssentialGuides(guides, {
  title: { text: 'Example manuscript', sourceBlockKey: 'block-1' },
  frontMatter: {
    authors: [{ text: 'Ada Lovelace', sourceBlockKeys: ['block-2'] }],
    affiliations: [{ text: 'Analytical Engine Institute', sourceBlockKeys: ['block-3'] }],
    keywords: []
  },
  references: {
    entries: [{ rawReferenceText: 'Smith 2020.', sourceBlockKey: 'block-9' }]
  }
});

assert.equal(evaluated[0].status, 'present');
assert.equal(evaluated[0].summary.present, 3);
assert.equal(evaluated[0].summary.na, 1);
assert.equal(evaluated[0].results[0].sourceBlockKey, 'block-1');
