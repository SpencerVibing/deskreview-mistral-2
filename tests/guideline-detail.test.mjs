import assert from 'node:assert/strict';
import {
  filterGuideResults,
  summarizeGuideResults
} from '../core/guideline-detail.js';

const results = [
  { id: 'a', status: 'present' },
  { id: 'b', status: 'warning' },
  { id: 'c', status: 'absent' },
  { id: 'd', status: 'present' }
];

assert.deepEqual(summarizeGuideResults(results), {
  total: 4,
  present: 2,
  warning: 1,
  absent: 1,
  na: 0,
  pending: 0
});
assert.equal(filterGuideResults(results, 'present').length, 2);
assert.equal(filterGuideResults(results, 'all').length, 4);
assert.equal(filterGuideResults(results, 'na').length, 0);
