import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { isPasswordCharsetError, passwordIsReady, PasswordRules } from '../../components/PasswordRules'
import { PasswordInput } from '../../components/PasswordInput'
import { SettingsBack } from '../../components/SettingsBack'

export function PasswordSettingsPage() {
  const navigate = useNavigate()
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [passwordChecked, setPasswordChecked] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setPasswordChecked(true)
    if (!passwordIsReady(pw.next)) {
      setError(null)
      return
    }
    if (pw.next !== pw.confirm) {
      setError('New passwords do not match')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(pw.current, pw.next)
      navigate('/settings')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <SettingsBack current="Change password" />
      <div className="page-header">
        <h1>Change password</h1>
        <p className="page-desc">Update your account password.</p>
      </div>
      <form className="panel stack" onSubmit={(e) => void onSubmit(e)}>
        <label>
          Current password
          <PasswordInput
            value={pw.current}
            onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))}
            required
            autoComplete="current-password"
          />
        </label>
        <label>
          New password
          <PasswordInput
            value={pw.next}
            onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
            required
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm new password
          <PasswordInput
            value={pw.confirm}
            onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
            required
            autoComplete="new-password"
          />
        </label>
        <PasswordRules value={pw.next} submitted={passwordChecked} />
        {error && !isPasswordCharsetError(error) && <p className="error">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </section>
  )
}
