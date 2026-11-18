import { personName, round2, text } from './money.ts'
import { rowsFromSheet } from './statement.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(round2(1.235) === 1.24, 'round2')
assert(text('"system"') === 'system', 'unwrap quoted text')
assert(personName('A', '', 'a@b.c') === 'A', 'name falls back past blank last name')
assert(personName('', '', 'a@b.c') === 'a@b.c', 'name falls back to email')

const rows = rowsFromSheet([
  ['Date', 'Credit', 'Description'],
  ['01/02/2026', '150', 'paid by a@b.c'],
  ['02/02/2026', '', 'debit only'],
])
assert(rows.length === 1 && rows[0].amount === 150, 'statement credit row')

console.log('ok')
