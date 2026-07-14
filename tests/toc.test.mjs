import assert from 'node:assert/strict';
import {
  firstBodyTocIndex,
  isBodyTocLabel,
  normalizeTocLabel,
  projectTocEntries
} from '../core/toc.js';

const humpbackEntries = [
  { label: 'Title', blockKey: 'block-0-0' },
  { label: 'A blind source separation approach for humpback whale song separation', blockKey: 'block-0-1' },
  { label: 'A blind source separation approach for humpback whale song separation', blockKey: 'block-1-4' },
  { label: 'Abstract', blockKey: 'block-1-9' },
  { label: 'I. INTRODUCTION', blockKey: 'block-2-0' }
];

const projected = projectTocEntries(humpbackEntries);
assert.deepEqual(
  projected.map((entry) => entry.displayLabel),
  ['Title', 'Abstract', 'I. INTRODUCTION']
);
assert.equal(projected[0].label, 'A blind source separation approach for humpback whale song separation');
assert.equal(projected[0].blockKey, 'block-1-4');

const fallback = projectTocEntries([
  { label: 'Title', blockKey: 'cover-title' },
  { label: 'Abstract', blockKey: 'abstract' }
]);
assert.equal(fallback[0].displayLabel, 'Title');
assert.equal(fallback[0].blockKey, 'cover-title');

assert.equal(normalizeTocLabel('  I. INTRODUCTION  '), 'i introduction');
assert.equal(isBodyTocLabel('III. METHODS'), true);
assert.equal(isBodyTocLabel('A long descriptive manuscript title'), false);
assert.equal(firstBodyTocIndex(projected), 1);
