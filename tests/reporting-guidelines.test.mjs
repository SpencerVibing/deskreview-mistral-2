import assert from 'node:assert/strict';
import {
  buildGuidelineMatchRequest,
  normalizeReportingMatches
} from '../core/reporting-guidelines.js';

const catalog = [{ id: 'strobe', label: 'STROBE', keywords: ['cohort'] }];
const normalized = normalizeReportingMatches({
  matches: [
    { guidelineId: 'strobe', confidence: 0.7, rationale: 'Cohort design', sourceBlockKey: 'block-1' },
    { guidelineId: '', confidence: 1 }
  ],
  warnings: ['Check design']
}, catalog);

assert.equal(normalized.matches.length, 1);
assert.equal(normalized.matches[0].label, 'STROBE');
assert.equal(normalized.matches[0].confidence, 0.7);
assert.equal(normalized.warnings[0], 'Check design');

const request = buildGuidelineMatchRequest({ title: { text: 'A cohort study' } }, catalog);
assert.equal(request.catalog[0].id, 'strobe');
assert.equal(request.documentAnnotation.title.text, 'A cohort study');
