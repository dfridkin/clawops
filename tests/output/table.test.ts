import { describe, it, expect } from 'vitest'
import { renderTable } from '../../src/output/table.js'

describe('renderTable()', () => {
  it('returns empty string for empty headers', () => {
    expect(renderTable([], [])).toBe('')
  })

  it('renders header + separator with no data rows', () => {
    const out = renderTable(['Name', 'Status'], [])
    const lines = out.split('\n')
    expect(lines[0]).toContain('Name')
    expect(lines[0]).toContain('Status')
    expect(lines[1]).toMatch(/^-/)
    expect(lines.length).toBe(2)
  })

  it('aligns columns to the widest value', () => {
    const out = renderTable(['Op', 'Count'], [
      ['create', '3'],
      ['same', '100'],
    ])
    const lines = out.split('\n')
    // All data cells in column 0 should have the same width (len of "create" = 6)
    const col0Width = lines[2]!.split('  ')[0]!.length
    expect(col0Width).toBe(6)
  })

  it('column width is at least as wide as the header', () => {
    const out = renderTable(['Operation', 'N'], [['up', '1']])
    const lines = out.split('\n')
    // "Operation" has 9 chars; "up" has 2 — column must be 9 wide
    const col0Width = lines[0]!.split('  ')[0]!.length
    expect(col0Width).toBe(9)
  })

  it('renders multi-row table correctly', () => {
    const out = renderTable(['A', 'B'], [['x', 'y'], ['z', 'w']])
    expect(out).toContain('x')
    expect(out).toContain('z')
    expect(out.split('\n').length).toBe(4) // header + sep + 2 rows
  })
})
