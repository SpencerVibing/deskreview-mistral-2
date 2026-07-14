function array(value = []) {
  return Array.isArray(value) ? value : [];
}

function text(value = '') {
  return String(value || '').trim();
}

function defaultEnabledMap(catalog = []) {
  return Object.fromEntries(array(catalog).map((plugin) => [
    text(plugin.id),
    plugin.defaultEnabled !== false
  ]).filter(([id]) => id));
}

export function normalizePluginPreferences(preferences = {}, catalog = []) {
  const enabled = {
    ...defaultEnabledMap(catalog),
    ...(preferences?.enabled && typeof preferences.enabled === 'object' ? preferences.enabled : {})
  };
  array(catalog).forEach((plugin) => {
    if (plugin.locked) enabled[plugin.id] = true;
  });
  const customGuides = array(preferences?.customGuides)
    .map((guide) => ({
      id: text(guide.id) || `custom-${Date.now()}`,
      name: text(guide.name),
      description: text(guide.description)
    }))
    .filter((guide) => guide.name);
  return { enabled, customGuides };
}

export function pluginIsEnabled(preferences = {}, pluginId = '') {
  return preferences?.enabled?.[pluginId] !== false;
}

export function setPluginEnabled(preferences = {}, catalog = [], pluginId = '', enabled = true) {
  const plugin = array(catalog).find((entry) => entry.id === pluginId);
  const normalized = normalizePluginPreferences(preferences, catalog);
  if (!plugin || plugin.locked) return normalized;
  return {
    ...normalized,
    enabled: {
      ...normalized.enabled,
      [pluginId]: Boolean(enabled)
    }
  };
}

export function addCustomGuide(preferences = {}, catalog = [], guide = {}) {
  const normalized = normalizePluginPreferences(preferences, catalog);
  const name = text(guide.name);
  if (!name) return normalized;
  return {
    ...normalized,
    customGuides: [
      ...normalized.customGuides,
      {
        id: text(guide.id) || `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        description: text(guide.description)
      }
    ]
  };
}

export function removeCustomGuide(preferences = {}, catalog = [], guideId = '') {
  const normalized = normalizePluginPreferences(preferences, catalog);
  return {
    ...normalized,
    customGuides: normalized.customGuides.filter((guide) => guide.id !== guideId)
  };
}
