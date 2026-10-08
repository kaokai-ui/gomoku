import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const hasSupabaseConfig = Boolean(supabaseUrl && publishableKey)

export const supabase = createClient(
  supabaseUrl || 'https://example.supabase.co',
  publishableKey || 'missing-publishable-key',
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  },
)

let anonymousSignIn: Promise<string> | null = null

export async function ensureAnonymousSession(): Promise<string> {
  const { data: current, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw sessionError
  if (current.session?.user.id) return current.session.user.id

  if (!anonymousSignIn) {
    anonymousSignIn = supabase.auth.signInAnonymously().then(({ data, error }) => {
      if (error) throw new Error('無法建立匿名登入，請在 Supabase Auth 設定中啟用 Anonymous Sign-Ins。')
      if (!data.user?.id) throw new Error('匿名登入沒有回傳玩家身份，請稍後再試。')
      return data.user.id
    }).finally(() => {
      anonymousSignIn = null
    })
  }
  return anonymousSignIn
}
