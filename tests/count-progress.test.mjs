import assert from 'node:assert/strict';
import {
  buildCountProgress,
  countBenchmarkForKind
} from '../core/count-progress.js';

assert.equal(countBenchmarkForKind('abstract').limit, 275);
assert.equal(countBenchmarkForKind('authors'), null);

const within = buildCountProgress({ count: 100, limit: 200, unit: 'words', sourceLabel: 'Generic benchmark' });
assert.equal(within.status, 'within');
assert.equal(within.segments.length, 2);
assert.equal(within.segments[0].width, 50);
assert.match(within.tooltip, /100 words counted/);

const over = buildCountProgress({ count: 75, limit: 50, unit: 'refs' });
assert.equal(over.status, 'over');
assert.equal(over.segments.length, 2);
assert.ok(over.segments[1].width > 30);
assert.match(over.tooltip, /above benchmark/);

const unavailable = buildCountProgress({ count: null, limit: 50, unit: 'refs' });
assert.equal(unavailable.status, 'unavailable');
assert.equal(unavailable.segments.length, 1);

const noLimit = buildCountProgress({ count: 3, limit: null, unit: 'authors' });
assert.equal(noLimit.status, 'ready');
assert.match(noLimit.tooltip, /No benchmark/);
