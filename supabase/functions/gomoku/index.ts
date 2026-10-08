import { withSupabase } from 'npm:@supabase/server@1'

type AppError = Error & { status?: number; code?: string }

function fail(status: number, code: string, message: string): AppError {
  return Object.assign(new Error(message), { status, code })
}

function response(data: unknown, status = 200): Response {
  return Response.json({ data }, { status })
}

function errorResponse(error: unknown): Response {
  const appError = error as AppError
  const status = appError.status ?? 500
  const code = appError.code ?? 'INTERNAL_ERROR'
  const publicMessages: Record<string, string> = {
    ROOM_NOT_FOUND: '找不到這個房間，請確認代碼是否正確。',
    ROOM_FULL: '這個房間已經有兩位玩家。',
    ROOM_NOT_WAITING: '這個房間已經開始或結束，無法加入。',
    ALREADY_IN_ROOM: '你已經在這個房間裡了。',
    GAME_NOT_FOUND: '找不到這場遊戲，或你不是房間玩家。',
    GAME_NOT_PLAYING: '遊戲已經結束，不能再落子。',
    NOT_A_PLAYER: '只有房間內的玩家可以操作。',
    NOT_YOUR_TURN: '還沒輪到你。',
    OUT_OF_BOUNDS: '落子位置超出棋盤範圍。',
    CELL_OCCUPIED: '這個位置已經有棋子了。',
    GAME_NOT_FINISHED: '只有已結束的遊戲可以重新開局。',
    AUTH_REQUIRED: '請先登入再操作。',
    INVALID_REQUEST: '送出的資料不完整或格式錯誤。',
    METHOD_NOT_ALLOWED: '此 API 不支援目前的 HTTP 方法。',
    ROUTE_NOT_FOUND: '找不到這個 API。',
    DATABASE_ERROR: '資料庫暫時無法處理，請稍後再試。',
    INTERNAL_ERROR: '伺服器暫時無法處理，請稍後再試。',
  }
  const message = publicMessages[code] ?? appError.message ?? '伺服器暫時無法處理，請稍後再試。'
  if (status >= 500) console.error('Gomoku API error:', code, message)
  return Response.json({ code, message }, { status })
}

function playerName(value: unknown): string {
  if (typeof value !== 'string') throw fail(400, 'INVALID_REQUEST', '請輸入 1 到 24 個字的暱稱。')
  const name = value.trim()
  if (name.length < 1 || name.length > 24) {
    throw fail(400, 'INVALID_REQUEST', '請輸入 1 到 24 個字的暱稱。')
  }
  return name
}

function roomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function readDbError(error: { code?: string; message?: string }): AppError {
  const message = error.message ?? ''
  const markers = [
    'ROOM_NOT_FOUND', 'ROOM_FULL', 'ROOM_NOT_WAITING', 'ALREADY_IN_ROOM',
    'GAME_NOT_FOUND', 'GAME_NOT_PLAYING', 'NOT_A_PLAYER', 'NOT_YOUR_TURN',
    'OUT_OF_BOUNDS', 'CELL_OCCUPIED', 'GAME_NOT_FINISHED',
  ]
  const marker = markers.find((candidate) => message.includes(candidate))
  if (marker) {
    const status = marker.endsWith('_NOT_FOUND') ? 404 : marker === 'NOT_A_PLAYER' ? 403 : 409
    return fail(status, marker, marker)
  }
  if (error.code === '23505') return fail(409, 'ROOM_CODE_COLLISION', '房間代碼重複，請再試一次。')
  console.error('Supabase request failed:', error.code, message)
  return fail(500, 'DATABASE_ERROR', '資料庫暫時無法處理，請稍後再試。')
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw fail(400, 'INVALID_REQUEST', '缺少有效的遊戲編號。')
  }
  return value
}

async function postBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw fail(400, 'INVALID_REQUEST', '請求內容不是有效的 JSON。')
  }
}

const fetchHandler = withSupabase({ auth: 'user' }, async (req, ctx) => {
  try {
    const userId = ctx.userClaims?.sub
    if (typeof userId !== 'string') throw fail(401, 'AUTH_REQUIRED', '請先登入再操作。')

    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)
    const functionIndex = segments.lastIndexOf('gomoku')
    const route = segments[functionIndex + 1] ?? ''

    if (route === 'create-room' && req.method === 'POST') {
      const body = await postBody(req)
      const name = playerName(body.playerName)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data, error } = await ctx.supabaseAdmin.rpc('gomoku_create_room', {
          p_room_code: roomCode(),
          p_user_id: userId,
          p_player_name: name,
        })
        if (!error) return response(data, 201)
        if (error.code !== '23505') throw readDbError(error)
      }
      throw fail(503, 'ROOM_CODE_UNAVAILABLE', '目前無法產生房間代碼，請再試一次。')
    }

    if (route === 'join-room' && req.method === 'POST') {
      const body = await postBody(req)
      const name = playerName(body.playerName)
      if (typeof body.roomCode !== 'string' || !/^[A-Z0-9]{6}$/i.test(body.roomCode.trim())) {
        throw fail(400, 'INVALID_REQUEST', '房間代碼需為 6 個英數字。')
      }
      const { data, error } = await ctx.supabaseAdmin.rpc('gomoku_join_room', {
        p_room_code: body.roomCode.trim().toUpperCase(),
        p_user_id: userId,
        p_player_name: name,
      })
      if (error) throw readDbError(error)
      return response(data)
    }

    if (route === 'move' && req.method === 'POST') {
      const body = await postBody(req)
      const gameId = requiredId(body.gameId)
      const x = body.x
      const y = body.y
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) {
        throw fail(400, 'INVALID_REQUEST', '落子座標必須是整數。')
      }
      const { data, error } = await ctx.supabaseAdmin.rpc('gomoku_submit_move', {
        p_game_id: gameId,
        p_user_id: userId,
        p_x: x,
        p_y: y,
      })
      if (error) throw readDbError(error)
      return response(data)
    }

    if (route === 'game' && req.method === 'GET') {
      const gameId = requiredId(url.searchParams.get('gameId'))
      const { data: game, error: gameError } = await ctx.supabase
        .from('gomoku_games')
        .select('*')
        .eq('id', gameId)
        .maybeSingle()
      if (gameError) throw fail(500, 'DATABASE_ERROR', '讀取遊戲狀態失敗，請稍後再試。')
      if (!game) throw fail(404, 'GAME_NOT_FOUND', '找不到這場遊戲，或你不是房間玩家。')

      const { data: moves, error: movesError } = await ctx.supabase
        .from('gomoku_moves')
        .select('*')
        .eq('game_id', gameId)
        .order('move_number', { ascending: true })
      if (movesError) throw fail(500, 'DATABASE_ERROR', '讀取棋盤失敗，請稍後再試。')
      return response({ game, moves: moves ?? [] })
    }

    if (route === 'rematch' && req.method === 'POST') {
      const body = await postBody(req)
      const gameId = requiredId(body.gameId)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data, error } = await ctx.supabaseAdmin.rpc('gomoku_create_rematch', {
          p_game_id: gameId,
          p_room_code: roomCode(),
          p_user_id: userId,
        })
        if (!error) return response(data, 201)
        if (error.code !== '23505') throw readDbError(error)
      }
      throw fail(503, 'ROOM_CODE_UNAVAILABLE', '目前無法產生新房間代碼，請再試一次。')
    }

    if (['create-room', 'join-room', 'move', 'game', 'rematch'].includes(route)) {
      throw fail(405, 'METHOD_NOT_ALLOWED', '此 API 不支援目前的 HTTP 方法。')
    }
    throw fail(404, 'ROUTE_NOT_FOUND', '找不到這個 API。')
  } catch (error) {
    return errorResponse(error)
  }
})

export default { fetch: fetchHandler }
