import { normalizeGuidelineCatalogEntry } from '/core/guideline-catalog.js';

export async function loadEssentialGuides() {
  const response = await fetch('/data/ease-essential-guidelines.json');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Essential guidelines failed to load (${response.status}).`);
  return Array.isArray(data?.guides) ? data.guides : [];
}

export async function loadReportingGuidelines() {
  const response = await fetch('/data/reporting-guidelines.json');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Reporting guidelines failed to load (${response.status}).`);
  return Array.isArray(data?.guidelines)
    ? data.guidelines.map(normalizeGuidelineCatalogEntry).filter((guide) => guide.id && guide.label)
    : [];
}

export async function loadGuidelineCatalogIndex() {
  const response = await fetch('/data/guidelines-index.json');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Guideline catalog failed to load (${response.status}).`);
  return (Array.isArray(data) ? data : [])
    .map(normalizeGuidelineCatalogEntry)
    .filter((guide) => guide.id && guide.label);
}

export async function loadGuidelineDetail(guideId = '') {
  const id = String(guideId || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid guideline id.');
  const response = await fetch(`/data/guidelines/${id}.json`);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Guideline detail failed to load (${response.status}).`);
  return normalizeGuidelineCatalogEntry(data || {});
}
