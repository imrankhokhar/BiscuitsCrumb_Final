import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY')
}

let accessToken: string | null = null

/** Keep the signed-in JWT on database calls. Without it PostgREST uses the anon role and Users rejects the query. */
export function rememberSession(token: string | null) {
  accessToken = token
}

export const supabase = createClient(url, key, {
  global: {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
      return fetch(input, { ...init, headers })
    },
  },
})

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.access_token) accessToken = session.access_token
  else if (event === 'SIGNED_OUT') accessToken = null
})

export const PROFILE_IMAGES_BUCKET = 'profile-images'
export const ITEM_IMAGES_BUCKET = 'item-images'
export const COMPANY_ASSETS_BUCKET = 'company-assets'
export const ATTACHMENTS_BUCKET = 'attachments'

/** Signup that must not replace the signed-in admin's browser session. */
export function signupClient() {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
