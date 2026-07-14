function text(value = '') {
  return String(value || '').trim();
}

function array(value = []) {
  return Array.isArray(value) ? value : [];
}

export function normalizeExternalUrl(value = '') {
  const raw = text(value);
  if (!raw) return '';
  const markdownMatch = raw.match(/\[[^\]]*]\((https?:\/\/[^)]+)\)/i);
  if (markdownMatch?.[1]) return markdownMatch[1].trim();
  const bareUrlMatch = raw.match(/https?:\/\/\S+/i);
  return bareUrlMatch?.[0]?.trim() || '';
}

export function normalizeGuideChecklist(guide = {}) {
  if (!guide || typeof guide !== 'object') return [];
  if (array(guide.Checklist).length) return guide.Checklist;
  if (array(guide.ChecklistTab).length) return guide.ChecklistTab;
  if (array(guide.items).length) {
    return [{
      section: guide.name || guide.Name || 'Checklist',
      items: guide.items.map((item) => ({
        item: text(item.id || item.item),
        item_name: text(item.label || item.item_name || item.id),
        item_question: text(item.requirement || item.item_question || item.description),
        item_question_background: text(item.background || item.item_question_background)
      }))
    }];
  }
  return [];
}

export function getChecklistGroups(guide = {}) {
  const checklist = normalizeGuideChecklist(guide);
  if (!checklist.length) return [];
  if (checklist.every((entry) => entry && typeof entry === 'object' && array(entry.items).length)) {
    return checklist.map((entry) => ({
      section: text(entry.section) || 'Uncategorized',
      items: array(entry.items)
    }));
  }
  const grouped = new Map();
  checklist.forEach((item) => {
    const section = text(item?.section) || 'Uncategorized';
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(item);
  });
  return Array.from(grouped.entries()).map(([section, items]) => ({ section, items }));
}

export function countChecklistItems(guide = {}) {
  return getChecklistGroups(guide).reduce((sum, group) => sum + group.items.length, 0);
}

export function getGuideDomainList(guide = {}) {
  const raw = guide.StandardizedTopDomain || guide.domain || guide.Domain;
  return array(raw).length ? array(raw).map(text).filter(Boolean) : (text(raw) ? [text(raw)] : []);
}

export function getGuideStudyTypes(guide = {}) {
  const raw = guide.ManuscriptType || guide.StudyType || guide.studyTypes || guide.manuscriptType;
  return array(raw).length ? array(raw).map(text).filter(Boolean) : (text(raw) ? [text(raw)] : []);
}

export function getGuideScopeSummary(guide = {}) {
  const scope = guide.Scope || guide.scope;
  if (typeof scope === 'string') return text(scope);
  if (scope && typeof scope === 'object') {
    return [scope.Focus, scope.Coverage, scope.ContrastWith].map(text).filter(Boolean).join(' ');
  }
  return text(guide.ScopeText);
}

function guideReferences(guide = {}) {
  const refs = guide.References || guide.references;
  return refs && typeof refs === 'object' ? refs : {};
}

export function getPrimaryReference(guide = {}) {
  const primary = guideReferences(guide).primary;
  return primary && typeof primary === 'object' ? primary : null;
}

export function getReferenceExamples(guide = {}) {
  return array(guideReferences(guide).examples);
}

export function guideLabel(guide = {}) {
  return text(guide.label || guide.Name || guide.name || guide.id);
}

export function guideDescription(guide = {}) {
  return text(guide.description || guide.Description);
}

export function guideKeywords(guide = {}) {
  return [
    ...array(guide.keywords),
    ...array(guide.Keywords),
    ...array(guide.Matching?.Aliases)
  ].map(text).filter(Boolean);
}

export function normalizeGuidelineCatalogEntry(guide = {}) {
  const id = text(guide.id);
  return {
    ...guide,
    id,
    label: guideLabel(guide),
    description: guideDescription(guide),
    keywords: guideKeywords(guide)
  };
}

export function guideMatchesSearch(guide = {}, term = '') {
  const needle = text(term).toLowerCase();
  if (!needle) return true;
  const haystack = [
    guideLabel(guide),
    guideDescription(guide),
    getGuideScopeSummary(guide),
    getGuideDomainList(guide).join(' '),
    getGuideStudyTypes(guide).join(' '),
    guide.Category,
    guide.Subdomain,
    guide.sourceLabel,
    guideKeywords(guide).join(' ')
  ].map(text).join(' ').toLowerCase();
  return haystack.includes(needle);
}

export function guideMatchesFacet(guide = {}, selectedFilter = 'All', filterType = 'none') {
  if (selectedFilter === 'All' || filterType === 'none') return true;
  if (filterType === 'essential') return Boolean(guide.isEssential);
  if (filterType === 'matched') return Boolean(guide.isMatched);
  if (filterType === 'recommended') return Boolean(guide.isStaticRecommended);
  if (filterType === 'custom') return Boolean(guide.isCustom);
  if (filterType === 'domain') return getGuideDomainList(guide).includes(selectedFilter);
  if (filterType === 'manuscriptType') return getGuideStudyTypes(guide).includes(selectedFilter);
  return true;
}

export function getManuscriptTypeOptions(guides = []) {
  const counts = new Map();
  array(guides).forEach((guide) => {
    getGuideStudyTypes(guide).forEach((type) => {
      counts.set(type, Number(counts.get(type) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .map(([type]) => type);
}
