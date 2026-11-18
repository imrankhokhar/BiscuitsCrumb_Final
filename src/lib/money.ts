export function round2(n: number) {
  return Math.round(n * 100) / 100
}

export function num(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** DB text sometimes stores a JSON string, including the quote characters. */
export function text(value: unknown) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function personName(first: string, last: string, email: string) {
  const name = `${first} ${last}`.trim()
  return name || email
}

export function splitName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}
