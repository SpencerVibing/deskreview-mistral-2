const STORAGE_KEY = 'deskreview-mistral-2-plugin-preferences';

export async function loadPluginCatalog() {
  const response = await fetch('/data/plugin-catalog.json');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Plugin catalog failed to load (${response.status}).`);
  return Array.isArray(data?.plugins) ? data.plugins : [];
}

export function loadPluginPreferences() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function savePluginPreferences(preferences = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences || {}));
  return preferences;
}
