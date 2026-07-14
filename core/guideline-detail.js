function array(value = []) {
  return Array.isArray(value) ? value : [];
}

export function summarizeGuideResults(results = []) {
  return array(results).reduce((summary, item) => {
    const status = String(item.status || 'warning');
    summary[status] = (summary[status] || 0) + 1;
    summary.total += 1;
    return summary;
  }, { total: 0, present: 0, warning: 0, absent: 0, optional: 0, na: 0, pending: 0 });
}

export function filterGuideResults(results = [], status = 'all') {
  const selected = String(status || 'all');
  if (selected === 'all') return array(results);
  return array(results).filter((item) => String(item.status || '') === selected);
}
