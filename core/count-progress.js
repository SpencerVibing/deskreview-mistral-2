export const COUNT_BENCHMARKS = Object.freeze({
  abstract: Object.freeze({ limit: 275, unit: 'words', sourceLabel: 'Generic abstract benchmark' }),
  article: Object.freeze({ limit: 6000, unit: 'words', sourceLabel: 'Generic article benchmark' }),
  references: Object.freeze({ limit: 50, unit: 'refs', sourceLabel: 'Generic reference benchmark' }),
  tables: Object.freeze({ limit: 8, unit: 'tables', sourceLabel: 'Generic display-item benchmark' }),
  figures: Object.freeze({ limit: 8, unit: 'figures', sourceLabel: 'Generic display-item benchmark' })
});

function toFiniteCount(value = null) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function unitLabel(value = null, unit = '') {
  const label = String(unit || '').trim();
  if (!label) return String(value ?? '-');
  const singular = label.replace(/s\b/i, '');
  return `${value ?? '-'} ${Number(value) === 1 ? singular : label}`;
}

function segment(className = '', width = 0, label = '') {
  return {
    className,
    width: Math.max(0, Math.min(100, Number(width) || 0)),
    label
  };
}

export function countBenchmarkForKind(kind = '') {
  return COUNT_BENCHMARKS[String(kind || '').trim()] || null;
}

export function buildCountProgress({ count = null, limit = null, unit = '', sourceLabel = '' } = {}) {
  const safeCount = toFiniteCount(count);
  const safeLimit = toFiniteCount(limit);
  const source = String(sourceLabel || '').trim();
  const sourceText = source ? ` ${source}.` : '';

  if (safeCount === null) {
    return {
      status: 'unavailable',
      tooltip: `Count unavailable.${sourceText}`,
      segments: [segment('bg-body-secondary', 100, 'Unavailable')]
    };
  }

  if (safeLimit === null || safeLimit <= 0) {
    return {
      status: 'ready',
      tooltip: `${unitLabel(safeCount, unit)} counted. No benchmark is configured.${sourceText}`,
      segments: [segment('bg-secondary-subtle', 100, 'Counted')]
    };
  }

  if (safeCount <= safeLimit) {
    const used = Math.max(4, Math.min(100, (safeCount / safeLimit) * 100));
    const remaining = Math.max(0, safeLimit - safeCount);
    return {
      status: 'within',
      tooltip: `${unitLabel(safeCount, unit)} counted. Benchmark: ${unitLabel(safeLimit, unit)}. ${unitLabel(remaining, unit)} below benchmark.${sourceText}`,
      segments: [
        segment('bg-success-subtle', used, `${unitLabel(safeCount, unit)} counted`),
        segment('bg-body-secondary', 100 - used, `${unitLabel(remaining, unit)} below benchmark`)
      ].filter((entry) => entry.width > 0)
    };
  }

  const allowed = Math.max(4, Math.min(96, (safeLimit / safeCount) * 100));
  const over = Math.max(0, safeCount - safeLimit);
  return {
    status: 'over',
    tooltip: `${unitLabel(safeCount, unit)} counted. Benchmark: ${unitLabel(safeLimit, unit)}. ${unitLabel(over, unit)} above benchmark.${sourceText}`,
    segments: [
      segment('bg-success-subtle', allowed, `${unitLabel(safeLimit, unit)} benchmark`),
      segment('bg-danger-subtle', 100 - allowed, `${unitLabel(over, unit)} above benchmark`)
    ].filter((entry) => entry.width > 0)
  };
}
