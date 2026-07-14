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
  return Array.isArray(data?.guidelines) ? data.guidelines : [];
}
