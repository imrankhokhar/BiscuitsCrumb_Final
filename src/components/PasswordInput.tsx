import { useState, type InputHTMLAttributes } from 'react'

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false)
  return (
    <span className="pw-field">
      <input {...props} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="pw-eye"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown((open) => !open)}
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </span>
  )
}

function Eye() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  )
}

function EyeOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 3l18 18M10.5 10.7A2.5 2.5 0 0 0 12 14.5M6.2 6.6C4.2 8 2.5 12 2.5 12S6 17.5 12 17.5c1.6 0 3-.4 4.2-1M9.8 6.7A9.8 9.8 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a16 16 0 0 1-3.2 3.4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  )
}
