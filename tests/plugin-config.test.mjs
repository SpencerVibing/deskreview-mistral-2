import assert from 'node:assert/strict';
import {
  addCustomGuide,
  normalizePluginPreferences,
  pluginIsEnabled,
  removeCustomGuide,
  setPluginEnabled
} from '../core/plugin-config.js';

const catalog = [
  { id: 'counts', locked: true, defaultEnabled: true },
  { id: 'essential', locked: false, defaultEnabled: true },
  { id: 'reporting', locked: false, defaultEnabled: false }
];

const normalized = normalizePluginPreferences({}, catalog);
assert.equal(pluginIsEnabled(normalized, 'counts'), true);
assert.equal(pluginIsEnabled(normalized, 'essential'), true);
assert.equal(pluginIsEnabled(normalized, 'reporting'), false);

const disabled = setPluginEnabled(normalized, catalog, 'essential', false);
assert.equal(pluginIsEnabled(disabled, 'essential'), false);

const locked = setPluginEnabled(normalized, catalog, 'counts', false);
assert.equal(pluginIsEnabled(locked, 'counts'), true);

const withGuide = addCustomGuide(disabled, catalog, { id: 'custom-1', name: 'Journal guide', description: 'Local rule' });
assert.equal(withGuide.customGuides.length, 1);
assert.equal(removeCustomGuide(withGuide, catalog, 'custom-1').customGuides.length, 0);
