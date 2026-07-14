import assert from 'node:assert/strict';
import { evaluateEssentialGuides } from '../core/essential-guidelines.js';

const guides = [{
  id: 'ease-abstract-page',
  name: 'Abstract page',
  items: [
    { id: 'title', type: 'title' },
    { id: 'authors', type: 'authors' },
    { id: 'references', type: 'references' },
    { id: 'keywords', type: 'keywords' }
  ]
}, {
  id: 'ease-imrad',
  name: 'IMRaD',
  items: [
    { id: 'methods', label: 'Methods', type: 'sectionKeywords', keywords: ['methods'] },
    { id: 'discussion', label: 'Discussion', type: 'sectionKeywords', keywords: ['discussion'] }
  ]
}, {
  id: 'ease-declarations',
  name: 'Declarations',
  items: [
    { id: 'funding', label: 'Funding', type: 'statementKeywords', keywords: ['funding'] }
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
  article: {
    sections: [
      { title: 'Methods', countedText: 'Methods text', sourceBlockKeys: ['block-4'] },
      { title: 'Results', countedText: 'Funding was provided by Example Council.', sourceBlockKeys: ['block-5'] }
    ]
  },
  references: {
    entries: [{ rawReferenceText: 'Smith 2020.', sourceBlockKey: 'block-9' }]
  }
});

assert.equal(evaluated[0].status, 'present');
assert.equal(evaluated[0].summary.present, 3);
assert.equal(evaluated[0].summary.na, 1);
assert.equal(evaluated[0].results[0].sourceBlockKey, 'block-1');
assert.equal(evaluated[1].status, 'absent');
assert.equal(evaluated[1].results[0].status, 'present');
assert.equal(evaluated[1].results[1].status, 'absent');
assert.equal(evaluated[2].status, 'present');
assert.equal(evaluated[2].results[0].sourceBlockKey, 'block-5');
