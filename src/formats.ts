// Export formats for result sets (no vscode import, unit-tested).

/**
 * Text that a spreadsheet would evaluate as a formula (OWASP "CSV injection") gets a leading
 * apostrophe. Real numbers are left alone, so -5 stays a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function csvCell(value: unknown): string {
  let t = text(value);
  if (typeof value === 'string' && FORMULA_START.test(t)) {
    t = `'${t}`;
  }
  return /[",\r\n]/.test(t) || t !== t.trim() ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))),
    null,
    2,
  );
}

function mdCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '*NULL*';
  }
  return text(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** GitHub-flavoured Markdown table, ready to paste into a ticket or pull request. */
export function toMarkdown(columns: string[], rows: unknown[][]): string {
  const head = `| ${columns.map(mdCell).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  return [head, rule, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n') + '\n';
}

/** Compact counts for tree descriptions: 950, 12.4K, 3.1M, 2.0B. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '?';
  }
  if (n < 1000) {
    return String(Math.round(n));
  }
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${unit}`;
    }
  }
  return String(n);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '?';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
