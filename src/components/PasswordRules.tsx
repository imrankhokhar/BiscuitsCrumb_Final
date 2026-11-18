const RULES = [
  {
    label: '8 characters',
    hint: (value: string) =>
      `Please lengthen this text to 8 characters or more (you are currently using ${value.length} ${value.length === 1 ? 'character' : 'characters'}).`,
    test: (value: string) => value.length >= 8,
  },
  { label: 'Lowercase letter', hint: 'Add a lowercase letter (a–z)', test: (value: string) => /[a-z]/.test(value) },
  { label: 'Uppercase letter', hint: 'Add an uppercase letter (A–Z)', test: (value: string) => /[A-Z]/.test(value) },
  { label: 'Number', hint: 'Add a number (0–9)', test: (value: string) => /\d/.test(value) },
  { label: 'Symbol', hint: 'Add a symbol such as ! @ #', test: (value: string) => /[^A-Za-z0-9]/.test(value) },
]

export function passwordIsReady(value: string) {
  return RULES.every((rule) => rule.test(value))
}

export function isPasswordCharsetError(message: string) {
  return /at least one character of each/i.test(message)
}

export function PasswordRules({ value, submitted = false }: { value: string; submitted?: boolean }) {
  return (
    <ul className={`pw-rules${submitted ? ' is-checked' : ''}`} aria-label="Password requirements">
      {RULES.map((rule) => {
        const met = rule.test(value)
        const missed = submitted && !met
        return (
          <li key={rule.label} className={met ? 'is-met' : missed ? 'is-miss' : ''}>
            <span className="pw-mark" aria-hidden>
              {met ? '✓' : missed ? '!' : ''}
            </span>
            <span>
              {rule.label}
              {missed && <small>{typeof rule.hint === 'function' ? rule.hint(value) : rule.hint}</small>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
