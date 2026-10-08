import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from './lib/api'
import { BOARD_SIZE, colorForPlayer, displayError, validateMove, winningLine } from './lib/game'
import { ensureAnonymousSession, hasSupabaseConfig, supabase } from './lib/supabase'
import type { Game, Move, Stone } from './lib/types'

const NAME_STORAGE_KEY = 'gomoku.playerName'

function explainError(error: unknown): string {
  if (error instanceof ApiError) return displayError(error.code, error.message)
  if (error instanceof Error) return error.message
  return '發生未預期的錯誤，請稍後再試。'
}

function App() {
  const [playerId, setPlayerId] = useState('')
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(NAME_STORAGE_KEY) ?? '')
  const [roomCode, setRoomCode] = useState('')
  const [game, setGame] = useState<Game | null>(null)
  const [moves, setMoves] = useState<Move[]>([])
  const [authReady, setAuthReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pendingCell, setPendingCell] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    const connect = async () => {
      if (!hasSupabaseConfig) {
        setError('請先複製 .env.example 為 .env.local，並填入 Supabase URL、Publishable Key 與 Edge Function API URL。')
        setAuthReady(true)
        return
      }
      try {
        const id = await ensureAnonymousSession()
        if (!active) return
        setPlayerId(id)
        const gameId = new URLSearchParams(window.location.search).get('game')
        if (gameId) {
          try {
            const snapshot = await api.getGame(gameId)
            if (!active) return
            setGame(snapshot.game)
            setMoves(snapshot.moves)
          } catch (loadError) {
            if (active) setError(explainError(loadError))
          }
        }
      } catch (authError) {
        if (active) setError(explainError(authError))
      } finally {
        if (active) setAuthReady(true)
      }
    }
    void connect()
    return () => { active = false }
  }, [])

  const setActiveGame = useCallback((nextGame: Game | null) => {
    setGame(nextGame)
    if (nextGame) {
      const url = new URL(window.location.href)
      url.searchParams.set('game', nextGame.id)
      window.history.replaceState({}, '', url)
    } else {
      const url = new URL(window.location.href)
      url.searchParams.delete('game')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])

  useEffect(() => {
    if (!game || !playerId) return
    let active = true
    const refresh = async () => {
      try {
        const snapshot = await api.getGame(game.id)
        if (active) {
          setGame(snapshot.game)
          setMoves(snapshot.moves)
        }
      } catch {
        // Realtime events are hints; keep the last valid board if a refresh briefly fails.
      }
    }
    const channel = supabase
      .channel(`gomoku-${game.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gomoku_games', filter: `id=eq.${game.id}` }, () => void refresh())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gomoku_moves', filter: `game_id=eq.${game.id}` }, () => void refresh())
      .subscribe((status) => {
        if (!active) return
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setNotice('即時同步暫時中斷，正在重新連線…')
        } else if (status === 'SUBSCRIBED') {
          setNotice('')
        }
      })
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [game?.id, playerId])

  const myColor = game && playerId ? colorForPlayer(game, playerId) : null
  const lastMove = moves[moves.length - 1]
  const winningCells = useMemo(
    () => game?.winner && lastMove ? winningLine(moves, lastMove) : new Set<string>(),
    [game?.winner, lastMove, moves],
  )
  const canMove = Boolean(game?.status === 'playing' && myColor && game.current_turn === myColor && !busy)

  function rememberName(name: string) {
    localStorage.setItem(NAME_STORAGE_KEY, name.trim())
    setPlayerName(name.trim())
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const name = playerName.trim()
    if (!name || name.length > 24) {
      setError('請輸入 1 到 24 個字的暱稱。')
      return
    }
    setBusy(true)
    try {
      rememberName(name)
      const created = await api.createRoom(name)
      setActiveGame(created)
      setMoves([])
      setNotice('房間建立好了，把代碼傳給朋友一起下棋。')
    } catch (createError) {
      setError(explainError(createError))
    } finally {
      setBusy(false)
    }
  }

  async function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const name = playerName.trim()
    if (!name || name.length > 24) {
      setError('請輸入 1 到 24 個字的暱稱。')
      return
    }
    if (roomCode.length !== 6) {
      setError('房間代碼需為 6 個英數字。')
      return
    }
    setBusy(true)
    try {
      rememberName(name)
      const joined = await api.joinRoom(roomCode, name)
      setActiveGame(joined)
      const snapshot = await api.getGame(joined.id)
      setMoves(snapshot.moves)
      setNotice('加入成功，黑棋先手。祝你下得順利！')
    } catch (joinError) {
      setError(explainError(joinError))
    } finally {
      setBusy(false)
    }
  }

  async function handleMove(x: number, y: number) {
    if (!game || !playerId || !canMove || busy) return
    try {
      validateMove(game, moves, playerId, x, y)
    } catch (validationError) {
      setError(explainError(validationError))
      return
    }
    setError('')
    setBusy(true)
    setPendingCell(`${x},${y}`)
    try {
      await api.move(game.id, x, y)
      const snapshot = await api.getGame(game.id)
      setGame(snapshot.game)
      setMoves(snapshot.moves)
    } catch (moveError) {
      setError(explainError(moveError))
    } finally {
      setBusy(false)
      setPendingCell(null)
    }
  }

  async function handleRematch() {
    if (!game) return
    setError('')
    setBusy(true)
    try {
      const nextGame = await api.rematch(game.id)
      setActiveGame(nextGame)
      setMoves([])
      setNotice('新的一局開始了，黑棋先下。')
    } catch (rematchError) {
      setError(explainError(rematchError))
    } finally {
      setBusy(false)
    }
  }

  async function copyRoomCode() {
    if (!game) return
    try {
      await navigator.clipboard.writeText(game.room_code)
      setNotice('房間代碼已複製。')
    } catch {
      setNotice(`請手動分享房間代碼：${game.room_code}`)
    }
  }

  function backToLobby() {
    setActiveGame(null)
    setMoves([])
    setError('')
    setNotice('')
  }

  if (game) {
    return (
      <div className="app-shell">
        <Header onHome={backToLobby} />
        <main className="game-layout">
          <div className="game-heading">
            <div>
              <p className="eyebrow">ROOM / {game.room_code}</p>
              <h1>{game.status === 'waiting' ? '等朋友入座' : game.status === 'finished' ? '這盤棋下完了' : '棋局進行中'}</h1>
            </div>
            <button className="quiet-button" type="button" onClick={copyRoomCode} aria-label="複製房間代碼">
              <span aria-hidden="true">↗</span> 分享房間
            </button>
          </div>

          {error && <p className="message message-error" role="alert">{error}</p>}
          {notice && <p className="message message-note" role="status">{notice}</p>}

          {game.status === 'waiting' ? (
            <WaitingRoom game={game} myColor={myColor} onCopy={copyRoomCode} />
          ) : (
            <div className="match-layout">
              <section className="board-panel" aria-label="五子棋棋盤">
                <div className={`turn-banner ${game.status === 'finished' ? 'turn-finished' : ''}`}>
                  <span className="turn-symbol" aria-hidden="true">{game.status === 'finished' ? '✦' : '●'}</span>
                  <span>
                    {game.status === 'finished'
                      ? game.winner ? `${game.winner === 'black' ? '黑棋' : '白棋'}獲勝！` : '平手！'
                      : game.current_turn === myColor ? '輪到你了，選一個位置。' : `輪到${game.current_turn === 'black' ? '黑棋' : '白棋'}，等對方落子…`}
                  </span>
                </div>
                <Board
                  moves={moves}
                  lastMove={lastMove}
                  winningCells={winningCells}
                  canMove={canMove}
                  pendingCell={pendingCell}
                  onMove={handleMove}
                />
                <div className="board-footer">
                  <span>15 × 15 棋盤</span>
                  <span>第 {moves.length} 手</span>
                </div>
              </section>

              <aside className="match-sidebar">
                <section className="players-card">
                  <p className="section-kicker">PLAYERS</p>
                  <PlayerRow color="black" name={game.black_name} active={game.status === 'playing' && game.current_turn === 'black'} mine={myColor === 'black'} />
                  <div className="player-divider" />
                  <PlayerRow color="white" name={game.white_name ?? '等待加入'} active={game.status === 'playing' && game.current_turn === 'white'} mine={myColor === 'white'} />
                </section>
                <section className="room-card">
                  <p className="section-kicker">ROOM CODE</p>
                  <div className="room-code-row">
                    <strong>{game.room_code}</strong>
                    <button className="copy-button" type="button" onClick={copyRoomCode} aria-label="複製房間代碼">複製</button>
                  </div>
                  <p className="muted-copy">房間代碼可以分享給朋友，讓他們加入對局。</p>
                </section>
                {game.status === 'finished' && (
                  <button className="primary-button rematch-button" type="button" onClick={() => void handleRematch()} disabled={busy}>
                    {busy ? '建立中…' : '↻　再來一局'}
                  </button>
                )}
                <p className="server-note"><span aria-hidden="true">✦</span> 每一步都由伺服器驗證，棋盤會即時同步。</p>
              </aside>
            </div>
          )}
        </main>
        <Footer />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Header />
      <main className="home-layout">
        <section className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-dot" /> A LITTLE GAME, A LONG WAY</p>
          <h1>把一盤棋，<br /><em>下到遠方。</em></h1>
          <p className="hero-description">邀請朋友開一盤五子棋。你們各自在不同的地方，棋子卻能落在同一張棋盤上。</p>
          <div className="feature-list">
            <span><i className="feature-icon feature-black" />15 × 15 棋盤</span>
            <span><i className="feature-icon feature-sync" />即時同步</span>
            <span><i className="feature-icon feature-lock" />匿名加入</span>
          </div>
          <div className="hero-art" aria-hidden="true">
            <span className="art-grid art-grid-one" />
            <span className="art-grid art-grid-two" />
            <span className="art-stone art-stone-black" />
            <span className="art-stone art-stone-white" />
            <span className="art-stone art-stone-amber" />
            <span className="art-caption">NEXT MOVE IS YOURS</span>
          </div>
        </section>

        <section className="lobby-card" aria-label="建立或加入房間">
          <div className="lobby-card-top">
            <span className="lobby-mark" aria-hidden="true">棋</span>
            <div>
              <p className="section-kicker">WELCOME TO THE TABLE</p>
              <h2>找個對手吧</h2>
            </div>
          </div>
          {!authReady && <p className="auth-status"><span className="spinner" />正在準備你的棋桌…</p>}
          {!hasSupabaseConfig && (
            <div className="setup-hint">
              <strong>還差一個設定步驟</strong>
              <span>填好 .env.local 中的 Supabase 環境變數後，就能建立房間。</span>
            </div>
          )}
          {error && <p className="message message-error" role="alert">{error}</p>}

          <form onSubmit={(event) => void handleCreate(event)}>
            <label className="field-label" htmlFor="player-name">你的暱稱</label>
            <input
              id="player-name"
              className="text-input"
              type="text"
              placeholder="例如：Thunder"
              autoComplete="nickname"
              maxLength={24}
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              required
            />
            <button className="primary-button create-button" type="submit" disabled={busy || !authReady || !hasSupabaseConfig}>
              {busy ? '請稍候…' : '建立新房間'} <span aria-hidden="true">↗</span>
            </button>
          </form>

          <div className="form-divider"><span>或是</span></div>

          <form onSubmit={(event) => void handleJoin(event)}>
            <label className="field-label" htmlFor="room-code">加入朋友的房間</label>
            <div className="join-row">
              <input
                id="room-code"
                className="text-input code-input"
                type="text"
                placeholder="輸入 6 位代碼"
                autoComplete="off"
                maxLength={6}
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                aria-describedby="room-code-help"
              />
              <button className="secondary-button" type="submit" disabled={busy || !authReady || !hasSupabaseConfig} aria-label="依代碼加入房間">
                加入 <span aria-hidden="true">→</span>
              </button>
            </div>
            <p className="field-help" id="room-code-help">請向房間建立者索取代碼。暱稱會沿用上方欄位。</p>
          </form>

          {notice && <p className="message message-note" role="status">{notice}</p>}
          <p className="privacy-note"><span aria-hidden="true">◈</span> 不用註冊帳號，系統會為你建立匿名玩家身份。</p>
        </section>
      </main>
      <Footer />
    </div>
  )
}

function Header({ onHome }: { onHome?: () => void }) {
  return (
    <header className="site-header">
      <button className="brand" type="button" onClick={onHome} aria-label="棋間首頁">
        <span className="brand-symbol"><i /><i /><i /></span>
        <span>棋間<span className="brand-divider">/</span><small>GOMOKU</small></span>
      </button>
      <div className="header-caption"><span className="live-dot" /> FRIENDS, ONE BOARD</div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="site-footer">
      <span>GOOD GAMES, GOOD COMPANY.</span>
      <span>黑棋先行 <b>·</b> 五子連線獲勝</span>
    </footer>
  )
}

function PlayerRow({ color, name, active, mine }: { color: Stone; name: string; active: boolean; mine: boolean }) {
  return (
    <div className={`player-row ${active ? 'player-active' : ''}`}>
      <span className={`player-piece player-piece-${color}`} aria-hidden="true" />
      <span className="player-copy">
        <strong>{name}{mine && <small className="you-tag">你</small>}</strong>
        <small>{color === 'black' ? 'BLACK' : 'WHITE'}</small>
      </span>
      <span className={`player-turn-dot ${active ? 'is-active' : ''}`} aria-label={active ? '目前回合' : undefined} />
    </div>
  )
}

function WaitingRoom({ game, myColor, onCopy }: { game: Game; myColor: Stone | null; onCopy: () => void }) {
  return (
    <section className="waiting-panel">
      <div className="waiting-copy">
        <span className="waiting-icon" aria-hidden="true">◷</span>
        <p className="section-kicker">WAITING FOR A FRIEND</p>
        <h2>棋桌已經擺好了。</h2>
        <p>你執黑先行。把房間代碼分享給朋友，對方加入後就能開始。</p>
        <div className="waiting-players">
          <PlayerRow color="black" name={game.black_name} active mine={myColor === 'black'} />
          <PlayerRow color="white" name="等待入座" active={false} mine={false} />
        </div>
        <button className="primary-button waiting-share" type="button" onClick={onCopy}>複製房間代碼　↗</button>
      </div>
      <div className="waiting-board" aria-hidden="true">
        <div className="waiting-board-lines" />
        <span className="waiting-stone waiting-stone-a" />
        <span className="waiting-stone waiting-stone-b" />
        <span className="waiting-board-label">YOUR TABLE IS READY</span>
      </div>
    </section>
  )
}

function Board({
  moves,
  lastMove,
  winningCells,
  canMove,
  pendingCell,
  onMove,
}: {
  moves: Move[]
  lastMove?: Move
  winningCells: Set<string>
  canMove: boolean
  pendingCell: string | null
  onMove: (x: number, y: number) => void
}) {
  const occupied = new Map(moves.map((move) => [`${move.x},${move.y}`, move]))
  return (
    <div className={`board-frame ${canMove ? 'board-interactive' : ''}`}>
      <div className="board-canvas">
        <svg className="board-lines" viewBox="0 0 140 140" preserveAspectRatio="none" aria-hidden="true">
          {Array.from({ length: BOARD_SIZE }, (_, index) => {
            const position = index * 10
            return <g key={index}><line x1={position} y1="0" x2={position} y2="140" /><line x1="0" y1={position} x2="140" y2={position} /></g>
          })}
        </svg>
        {Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => {
          const x = index % BOARD_SIZE
          const y = Math.floor(index / BOARD_SIZE)
          const key = `${x},${y}`
          const move = occupied.get(key)
          const last = lastMove?.x === x && lastMove.y === y
          const winning = winningCells.has(key)
          const pending = pendingCell === key
          const disabled = !canMove || Boolean(move) || pending
          return (
            <button
              key={key}
              type="button"
              className={`board-point ${move ? `has-stone stone-${move.color}` : ''} ${last ? 'last-stone' : ''} ${winning ? 'winning-stone' : ''} ${pending ? 'stone-pending' : ''}`}
              style={{ left: `${8.4 + (x / 14) * 83.2}%`, top: `${8.4 + (y / 14) * 83.2}%` }}
              onClick={() => onMove(x, y)}
              disabled={disabled}
              aria-label={`第 ${y + 1} 行，第 ${x + 1} 列${move ? `，${move.color === 'black' ? '黑棋' : '白棋'}` : ''}`}
              title={move ? `${move.color === 'black' ? '黑棋' : '白棋'} · 第 ${move.move_number} 手` : canMove ? '在此落子' : undefined}
            >
              {move && <span className="stone-disc" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default App
