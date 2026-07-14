import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  countChecklistItems,
  getChecklistGroups,
  getGuideDomainList,
  getGuideStudyTypes,
  getPrimaryReference,
  guideDescription,
  guideKeywords,
  guideLabel,
  guideMatchesSearch,
  normalizeExternalUrl,
  normalizeGuidelineCatalogEntry
} from '../core/guideline-catalog.js';

const consort = JSON.parse(await readFile(new URL('../data/guidelines/consort.json', import.meta.url), 'utf8'));
const normalized = normalizeGuidelineCatalogEntry(consort);

assert.equal(guideLabel(normalized), 'CONSORT');
assert.match(guideDescription(normalized), /randomised trial reports/i);
assert.ok(guideKeywords(normalized).includes('CONSORT'));
assert.ok(getGuideDomainList(normalized).includes('Medical and health'));
assert.ok(getGuideStudyTypes(normalized).includes('Randomised controlled trial report'));
assert.ok(countChecklistItems(normalized) >= 30);
assert.equal(getChecklistGroups(normalized)[0].section, 'Title and abstract');
assert.match(getPrimaryReference(normalized).url, /^https:\/\/www\.bmj\.com/);
assert.equal(normalizeExternalUrl('[Official](https://example.org/a.pdf)'), 'https://example.org/a.pdf');
assert.equal(guideMatchesSearch(normalized, 'randomised trial'), true);
assert.equal(guideMatchesSearch(normalized, 'qualitative interview'), false);
