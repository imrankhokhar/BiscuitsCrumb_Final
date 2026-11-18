import type { SheetCredit } from '../../server/src/lib/cashlineMatch.ts'

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function normalizeHeader(h: string) {
  return h.trim().toLowerCase().replace(/[\s_]+/g, ' ')
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[, ]/g, '').replace(/[^\d.-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return round2(Math.abs(n))
}

function parseDateLoose(raw: string | Date | null | undefined): Date | null {
  if (!raw) return null
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw
  const s = String(raw).trim()
  if (!s) return null
  const excelSerial = Number(s)
  if (Number.isFinite(excelSerial) && excelSerial > 20000 && excelSerial < 80000) {
    const ms = (excelSerial - 25569) * 86400 * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (dmy) {
    const day = Number(dmy[1])
    const month = Number(dmy[2])
    let year = Number(dmy[3])
    if (year < 100) year += 2000
    const d = new Date(Date.UTC(year, month - 1, day))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

type ColMap = {
  date?: number
  amount?: number
  credit?: number
  debit?: number
  description?: number
}

function mapHeaders(headers: string[]): ColMap | null {
  const map: ColMap = {}
  headers.forEach((h, i) => {
    const n = normalizeHeader(h)
    if (!n) return
    if (map.date == null && /\b(date|txn date|value date|trans date|transaction date)\b/.test(n)) {
      map.date = i
    } else if (map.credit == null && /\b(credit|deposit|inflow|money in|cr)\b/.test(n)) {
      map.credit = i
    } else if (map.debit == null && /\b(debit|withdrawal|outflow|money out|dr)\b/.test(n)) {
      map.debit = i
    } else if (map.amount == null && /\b(amount|txn amount|transaction amount|value)\b/.test(n)) {
      map.amount = i
    } else if (
      map.description == null &&
      /\b(description|narration|particulars|reference|details|memo|remarks|narrative|payee)\b/.test(n)
    ) {
      map.description = i
    }
  })
  if (map.credit == null && map.amount == null) return null
  return map
}

export function rowsFromSheet(rows: string[][]): SheetCredit[] {
  if (rows.length < 2) return []
  let headerIdx = -1
  let cols: ColMap | null = null
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const mapped = mapHeaders(rows[i])
    if (mapped) {
      headerIdx = i
      cols = mapped
      break
    }
  }
  if (headerIdx < 0 || !cols) {
    throw new Error(
      'Could not find statement columns. Need a header row with Date, Amount (or Credit), and optionally Description/Reference.',
    )
  }
  const out: SheetCredit[] = []
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every((c) => !String(c ?? '').trim())) continue
    const desc = cols.description != null ? String(row[cols.description] ?? '').trim() : ''
    const date = parseDateLoose(cols.date != null ? row[cols.date] : '')
    let amount: number | null = null
    if (cols.credit != null) {
      const credit = parseAmount(String(row[cols.credit] ?? ''))
      const debit = cols.debit != null ? parseAmount(String(row[cols.debit] ?? '')) : null
      if (credit != null && credit > 0) amount = credit
      else if (debit != null && debit > 0) continue
    } else if (cols.amount != null) {
      const raw = String(row[cols.amount] ?? '').trim()
      if (!raw) continue
      if (/^-/.test(raw) || /\bdr\b/i.test(raw)) continue
      amount = parseAmount(raw)
    }
    if (amount == null || amount <= 0) continue
    out.push({
      key: `s-${r}`,
      rowIndex: r + 1,
      date,
      amount,
      description: desc || (cols.date == null ? String(row.join(' ')).trim() : ''),
    })
  }
  return out
}

function parseCsv(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return lines.map((line) => {
    const cells: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        inQ = !inQ
        continue
      }
      if (ch === ',' && !inQ) {
        cells.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    cells.push(cur)
    return cells
  })
}

function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if ('text' in v && typeof (v as { text?: string }).text === 'string') return (v as { text: string }).text
    if ('result' in v) return cellText((v as { result: unknown }).result)
    if ('richText' in v) {
      const rt = (v as { richText: { text: string }[] }).richText
      return rt.map((p) => p.text).join('')
    }
  }
  return String(v)
}

export async function parseStatement(file: File): Promise<SheetCredit[]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv')) return rowsFromSheet(parseCsv(await file.text()))
  if (name.endsWith('.pdf')) {
    throw new Error('PDF statements are not parsed in the browser. Export the sheet as CSV or Excel.')
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(await file.arrayBuffer())
    } catch {
      throw new Error('Could not read Excel file. Use .xlsx (or export CSV).')
    }
    const sheet = wb.worksheets[0]
    if (!sheet) throw new Error('Excel file has no sheets')
    const rows: string[][] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        while (vals.length < col - 1) vals.push('')
        vals.push(cell.value instanceof Date ? cell.value.toISOString() : cellText(cell.value))
      })
      rows.push(vals)
    })
    return rowsFromSheet(rows)
  }
  throw new Error('Unsupported file type. Upload .xlsx or .csv')
}
