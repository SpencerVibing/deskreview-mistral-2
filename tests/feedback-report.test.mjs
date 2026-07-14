import assert from 'node:assert/strict';
import {
  buildFeedbackReportModel,
  summarizeStatuses
} from '../core/feedback-report.js';

assert.deepEqual(summarizeStatuses([{ status: 'present' }, { status: 'warning' }]), {
  total: 2,
  present: 1,
  warning: 1,
  absent: 0,
  na: 0
});

const model = buildFeedbackReportModel({
  essentialResults: [{
    id: 'ease',
    name: 'EASE',
    results: [{ id: 'title', label: 'Title', status: 'present', evidenceQuote: 'Example', sourceBlockKey: 'block-1' }]
  }],
  reportingMatches: {
    matches: [{ guidelineId: 'strobe', label: 'STROBE', confidence: 0.8 }]
  },
  annotation: {
    quoteAnchors: [{ kind: 'title', label: 'Title', quote: 'Example', sourceBlockKey: 'block-1' }]
  }
});

assert.equal(model.essentialGuides[0].summary.present, 1);
assert.equal(model.reportingMatches[0].label, 'STROBE');
assert.equal(model.quoteAnchors[0].sourceBlockKey, 'block-1');
