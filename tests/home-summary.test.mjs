import assert from 'node:assert/strict';
import { summarizeHome } from '../core/home-summary.js';

const summary = summarizeHome({
  reviews: [
    { pageCount: 10, documentAnnotation: { status: 'ready' } },
    { pageCount: 5, documentAnnotation: { status: 'failed' } }
  ],
  examples: [{ id: 'a' }, { id: 'b' }]
});

assert.deepEqual(summary, {
  storedReviews: 2,
  totalPages: 15,
  annotatedReviews: 1,
  examples: 2
});
