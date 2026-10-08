import type { Game, Move, Stone } from './types'

export const BOARD_SIZE = 15

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

export type MoveErrorCode =
  | 'GAME_NOT_PLAYING'
  | 'NOT_A_PLAYER'
  | 'NOT_YOUR_TURN'
  | 'OUT_OF_BOUNDS'
  | 'CELL_OCCUPIED'

export class MoveValidationError extends Error {
  constructor(readonly code: MoveErrorCode, message: string) {
    super(message)
    this.name = 'MoveValidationError'
  }
}

export function colorForPlayer(game: Game, userId: string): Stone | null {
  if (game.black_user_id === userId) return 'black'
  if (game.white_user_id === userId) return 'white'
  return null
}

/** Client-side feedback only. The Edge Function and database remain authoritative. */
export function validateMove(
  game: Game,
  moves: Move[],
  userId: string,
  x: number,
  y: number,
): void {
  if (game.status !== 'playing') {
    throw new MoveValidationError('GAME_NOT_PLAYING', '這場遊戲目前不能落子。')
  }
  const color = colorForPlayer(game, userId)
  if (!color) {
    throw new MoveValidationError('NOT_A_PLAYER', '只有房間內的兩位玩家可以落子。')
  }
  if (game.current_turn !== color) {
    throw new MoveValidationError('NOT_YOUR_TURN', '還沒輪到你，等對方落子吧。')
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) {
    throw new MoveValidationError('OUT_OF_BOUNDS', '請選擇棋盤範圍內的位置。')
  }
  if (moves.some((move) => move.x === x && move.y === y)) {
    throw new MoveValidationError('CELL_OCCUPIED', '這個位置已經有棋子了。')
  }
}

/** Checks only lines passing through the most recent move. */
export function hasFiveInRow(moves: Move[], lastMove: Pick<Move, 'x' | 'y' | 'color'>): boolean {
  const occupied = new Set(
    moves.filter((move) => move.color === lastMove.color).map((move) => `${move.x},${move.y}`),
  )

  return DIRECTIONS.some(([dx, dy]) => {
    let count = 1
    for (const sign of [-1, 1]) {
      for (let step = 1; step < 5; step += 1) {
        const key = `${lastMove.x + dx * step * sign},${lastMove.y + dy * step * sign}`
        if (!occupied.has(key)) break
        count += 1
      }
    }
    return count >= 5
  })
}

export function winningLine(moves: Move[], lastMove: Pick<Move, 'x' | 'y' | 'color'>): Set<string> {
  const occupied = new Set(
    moves.filter((move) => move.color === lastMove.color).map((move) => `${move.x},${move.y}`),
  )
  for (const [dx, dy] of DIRECTIONS) {
    const line = [`${lastMove.x},${lastMove.y}`]
    for (const sign of [-1, 1]) {
      for (let step = 1; step < 5; step += 1) {
        const key = `${lastMove.x + dx * step * sign},${lastMove.y + dy * step * sign}`
        if (!occupied.has(key)) break
        line.push(key)
      }
    }
    if (line.length >= 5) return new Set(line)
  }
  return new Set()
}

export function displayError(code: string | undefined, fallback: string): string {
  const messages: Record<string, string> = {
    ROOM_NOT_FOUND: '找不到這個房間，請確認代碼是否正確。',
    ROOM_FULL: '這個房間已經有兩位玩家。',
    ROOM_NOT_WAITING: '這個房間已經開始或結束，無法加入。',
    ALREADY_IN_ROOM: '你已經在這個房間裡了。',
    GAME_NOT_FOUND: '找不到這場遊戲。',
    GAME_NOT_PLAYING: '遊戲已經結束，不能再落子。',
    NOT_A_PLAYER: '只有房間內的玩家可以操作。',
    NOT_YOUR_TURN: '還沒輪到你。',
    OUT_OF_BOUNDS: '落子位置超出棋盤範圍。',
    CELL_OCCUPIED: '這個位置已經有棋子了。',
    GAME_NOT_FINISHED: '只有已結束的遊戲可以重新開局。',
    INVALID_REQUEST: '送出的資料不完整或格式錯誤。',
    AUTH_REQUIRED: '登入狀態已失效，請重新整理頁面。',
  }
  return code ? messages[code] ?? fallback : fallback
}
