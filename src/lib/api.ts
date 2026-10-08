import { supabase } from './supabase'
import type { Game, GameSnapshot } from './types'

const apiBase = import.meta.env.VITE_API_BASE?.trim().replace(/\/$/, '')

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!apiBase) throw new ApiError('CONFIG_MISSING', '請先在 .env.local 設定 VITE_API_BASE。', 0)
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new ApiError('AUTH_REQUIRED', '登入狀態失效，請重新整理頁面。', 401)
  const session = data.session
  if (!session) throw new ApiError('AUTH_REQUIRED', '尚未登入，請重新整理頁面。', 401)

  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', '連線失敗，請檢查網路後再試。', 0)
  }

  const payload = await response.json().catch(() => ({})) as { data?: T; code?: string; message?: string }
  if (!response.ok) {
    throw new ApiError(payload.code ?? 'REQUEST_FAILED', payload.message ?? '伺服器暫時無法處理，請稍後再試。', response.status)
  }
  return (payload.data ?? payload) as T
}

export const api = {
  createRoom(playerName: string) {
    return request<Game>('/create-room', { method: 'POST', body: JSON.stringify({ playerName }) })
  },
  joinRoom(roomCode: string, playerName: string) {
    return request<Game>('/join-room', { method: 'POST', body: JSON.stringify({ roomCode, playerName }) })
  },
  getGame(gameId: string) {
    return request<GameSnapshot>(`/game?gameId=${encodeURIComponent(gameId)}`, { method: 'GET' })
  },
  move(gameId: string, x: number, y: number) {
    return request<{ game: Game; move: GameSnapshot['moves'][number] }>('/move', {
      method: 'POST',
      body: JSON.stringify({ gameId, x, y }),
    })
  },
  rematch(gameId: string) {
    return request<Game>('/rematch', { method: 'POST', body: JSON.stringify({ gameId }) })
  },
}
