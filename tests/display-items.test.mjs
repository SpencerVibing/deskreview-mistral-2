import assert from 'node:assert/strict';
import {
  excludedDisplayItems,
  normalizeResolvedDisplayItems,
  readyDisplayItems
} from '../core/display-items.js';

const sourceItems = [
  { itemId: 'fig-1a', kind: 'figure', sourceBlockKey: 'block-1', key: 'block-1' },
  { itemId: 'fig-1b', kind: 'figure', sourceBlockKey: 'block-2', key: 'block-2' },
  { itemId: 'fragment', kind: 'figure', sourceBlockKey: 'block-3', key: 'block-3' },
  { itemId: 'table-1', kind: 'table', sourceBlockKey: 'block-4', key: 'block-4' },
  { itemId: 'supp-1', kind: 'figure', sourceBlockKey: 'block-5', key: 'block-5' }
];

const normalized = normalizeResolvedDisplayItems({
  sourceItems,
  resolvedItems: [
    {
      itemId: 'fig-1a',
      kind: 'figure',
      sourceBlockKey: 'wrong-block',
      label: 'Figure 1(a)',
      isManuscriptItem: true,
      citationOccurrences: [{ blockKey: 'body-1', citationText: 'Figure 1', contextQuote: 'See Figure 1.' }]
    },
    {
      itemId: 'fig-1b',
      kind: 'figure',
      label: 'Figure 1b',
      isManuscriptItem: true,
      citationOccurrences: [{ blockKey: 'body-2', citationText: 'Fig. 1', contextQuote: 'As shown in Fig. 1.' }]
    },
    {
      itemId: 'fragment',
      kind: 'figure',
      label: 'Separated source 1 at channel 1',
      isManuscriptItem: true
    },
    {
      itemId: 'table-1',
      kind: 'table',
      label: 'Table IV',
      isManuscriptItem: true
    },
    {
      itemId: 'fig-1a',
      kind: 'figure',
      label: 'Figure 4',
      isManuscriptItem: true
    },
    {
      itemId: 'supp-1',
      kind: 'figure',
      label: 'Figure S1',
      isManuscriptItem: true
    }
  ]
});

const ready = readyDisplayItems(normalized);
assert.deepEqual(ready.map((item) => item.label), ['Figure 1', 'Table IV']);
assert.equal(ready.find((item) => item.label === 'Figure 1').key, 'block-1');
assert.equal(ready.find((item) => item.label === 'Figure 1').citationOccurrences.length, 2);

const excludedFigures = excludedDisplayItems(normalized, 'figure');
assert.equal(excludedFigures.length, 4);
assert.ok(excludedFigures.some((item) => /fragment/.test(item.exclusionReason || '')));
assert.ok(excludedFigures.some((item) => /Supplementary figure/.test(item.exclusionReason || '')));
