export async function loadExampleManuscripts() {
  const response = await fetch('/data/example-manuscripts.json');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Example manuscripts failed to load (${response.status}).`);
  return Array.isArray(data?.examples) ? data.examples : [];
}
