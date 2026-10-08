export type Stone = 'black' | 'white'
export type GameStatus = 'waiting' | 'playing' | 'finished'

export interface Game {
  id: string
  room_code: string
  black_user_id: string
  black_name: string
  white_user_id: string | null
  white_name: string | null
  current_turn: Stone
  status: GameStatus
  winner: Stone | null
  created_at: string
  updated_at: string
  finished_at: string | null
  rematch_of_game_id: string | null
}

export interface Move {
  id: string
  game_id: string
  user_id: string
  color: Stone
  x: number
  y: number
  move_number: number
  created_at: string
}

export interface GameSnapshot {
  game: Game
  moves: Move[]
}

export interface MoveIntent {
  x: number
  y: number
}
