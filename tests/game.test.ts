import { describe, expect, it } from 'vitest'
import { hasFiveInRow, validateMove, MoveValidationError } from '../src/lib/game'
import type { Game, Move, Stone } from '../src/lib/types'

function move(x: number, y: number, color: Stone = 'black', move_number = 1): Move {
  return {
    id: `${x}-${y}`,
    game_id: 'game-1',
    user_id: color === 'black' ? 'black-user' : 'white-user',
    color,
    x,
    y,
    move_number,
    created_at: '',
  }
}

const game: Game = {
  id: 'game-1',
  room_code: 'ABCD23',
  black_user_id: 'black-user',
  black_name: 'Thunder',
  white_user_id: 'white-user',
  white_name: 'Alice',
  current_turn: 'black',
  status: 'playing',
  winner: null,
  created_at: '',
  updated_at: '',
  finished_at: null,
  rematch_of_game_id: null,
}

describe('hasFiveInRow', () => {
  it('recognizes five black stones horizontally', () => {
    const moves = [2, 3, 4, 5, 6].map((x, index) => move(x, 7, 'black', index + 1))
    expect(hasFiveInRow(moves, moves[4])).toBe(true)
  })

  it('recognizes five white stones vertically', () => {
    const moves = [3, 4, 5, 6, 7].map((y, index) => move(8, y, 'white', index + 1))
    expect(hasFiveInRow(moves, moves[4])).toBe(true)
  })

  it('recognizes an upper-left to lower-right diagonal', () => {
    const moves = [2, 3, 4, 5, 6].map((point, index) => move(point, point, 'black', index + 1))
    expect(hasFiveInRow(moves, moves[4])).toBe(true)
  })

  it('recognizes an upper-right to lower-left diagonal', () => {
    const moves = [2, 3, 4, 5, 6].map((point, index) => move(point, 8 - point, 'white', index + 1))
    expect(hasFiveInRow(moves, moves[4])).toBe(true)
  })

  it('does not report four in a row as a win', () => {
    const moves = [4, 5, 6, 7].map((x, index) => move(x, 9, 'black', index + 1))
    expect(hasFiveInRow(moves, moves[3])).toBe(false)
  })

  it('counts six in a row as a win', () => {
    const moves = [4, 5, 6, 7, 8, 9].map((x, index) => move(x, 10, 'white', index + 1))
    expect(hasFiveInRow(moves, moves[5])).toBe(true)
  })
})

describe('validateMove', () => {
  it('rejects a move when it is not the player’s turn', () => {
    expect(() => validateMove(game, [], 'white-user', 2, 2)).toThrowError(MoveValidationError)
    expect(() => validateMove(game, [], 'white-user', 2, 2)).toThrow('還沒輪到你')
  })

  it('rejects an occupied intersection', () => {
    expect(() => validateMove(game, [move(2, 2)], 'black-user', 2, 2)).toThrow('這個位置已經有棋子')
  })

  it('rejects coordinates outside the 15 by 15 board', () => {
    expect(() => validateMove(game, [], 'black-user', 15, 4)).toThrow('棋盤範圍內')
  })

  it('rejects moves after the game has finished', () => {
    const finishedGame = { ...game, status: 'finished' as const, winner: 'black' as const }
    expect(() => validateMove(finishedGame, [], 'black-user', 2, 2)).toThrow('目前不能落子')
  })

  it('rejects a user who is not one of the two players', () => {
    expect(() => validateMove(game, [], 'spectator-user', 2, 2)).toThrow('只有房間內的兩位玩家')
  })

  it('accepts an in-range move by the current player on an empty cell', () => {
    expect(() => validateMove(game, [], 'black-user', 14, 0)).not.toThrow()
  })
})
