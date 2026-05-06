// ASCII table renderer — column-aligned, no external deps.

/**
 * Render a table as a formatted string.
 *
 * @param headers  Column header labels.
 * @param rows     Data rows; each row must have the same length as headers.
 * @returns        Multi-line string with aligned columns and a header separator.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return ''

  // Compute column widths (max of header vs all cell values)
  const widths = headers.map((h, i) => {
    const cellMax = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0)
    return Math.max(h.length, cellMax)
  })

  const pad = (s: string, w: number) => s + ' '.repeat(w - s.length)
  const sep = '  '

  const header = headers.map((h, i) => pad(h, widths[i] ?? h.length)).join(sep)
  const divider = widths.map(w => '-'.repeat(w)).join(sep)
  const body = rows
    .map(row => row.map((cell, i) => pad(cell, widths[i] ?? cell.length)).join(sep))
    .join('\n')

  return [header, divider, ...(body ? [body] : [])].join('\n')
}
