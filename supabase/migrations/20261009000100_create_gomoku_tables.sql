create table if not exists public.gomoku_games (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{6}$'),
  black_user_id uuid not null references auth.users(id) on delete cascade,
  black_name text not null check (char_length(trim(black_name)) between 1 and 24),
  white_user_id uuid references auth.users(id) on delete cascade,
  white_name text check (white_name is null or char_length(trim(white_name)) between 1 and 24),
  current_turn text not null default 'black' check (current_turn in ('black', 'white')),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
  winner text check (winner is null or winner in ('black', 'white')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  rematch_of_game_id uuid unique references public.gomoku_games(id) on delete set null,
  constraint gomoku_distinct_players check (white_user_id is null or white_user_id <> black_user_id),
  constraint gomoku_player_pair check ((white_user_id is null) = (white_name is null)),
  constraint gomoku_status_state check (
    (status = 'waiting' and white_user_id is null and current_turn = 'black' and winner is null and finished_at is null)
    or (status = 'playing' and white_user_id is not null and winner is null and finished_at is null)
    or (status = 'finished' and white_user_id is not null and finished_at is not null)
  )
);

create table if not exists public.gomoku_moves (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.gomoku_games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  color text not null check (color in ('black', 'white')),
  x integer not null check (x between 0 and 14),
  y integer not null check (y between 0 and 14),
  move_number integer not null check (move_number between 1 and 225),
  created_at timestamptz not null default now(),
  constraint gomoku_one_stone_per_cell unique (game_id, x, y),
  constraint gomoku_sequential_move_number unique (game_id, move_number)
);

create index if not exists gomoku_games_black_user_idx on public.gomoku_games (black_user_id);
create index if not exists gomoku_games_white_user_idx on public.gomoku_games (white_user_id) where white_user_id is not null;
create index if not exists gomoku_moves_game_order_idx on public.gomoku_moves (game_id, move_number);
create index if not exists gomoku_moves_user_idx on public.gomoku_moves (user_id);

create or replace function public.gomoku_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists gomoku_games_set_updated_at on public.gomoku_games;
create trigger gomoku_games_set_updated_at
before update on public.gomoku_games
for each row execute function public.gomoku_set_updated_at();
revoke all on function public.gomoku_set_updated_at() from public, anon, authenticated;

alter table public.gomoku_games enable row level security;
alter table public.gomoku_moves enable row level security;

revoke all on public.gomoku_games from public, anon, authenticated;
revoke all on public.gomoku_moves from public, anon, authenticated;
grant select on public.gomoku_games to authenticated;
grant select on public.gomoku_moves to authenticated;
grant all on public.gomoku_games to service_role;
grant all on public.gomoku_moves to service_role;

drop policy if exists "Players can read their games" on public.gomoku_games;
create policy "Players can read their games"
on public.gomoku_games for select to authenticated
using (black_user_id = (select auth.uid()) or white_user_id = (select auth.uid()));

drop policy if exists "Players can read moves in their games" on public.gomoku_moves;
create policy "Players can read moves in their games"
on public.gomoku_moves for select to authenticated
using (
  exists (
    select 1
    from public.gomoku_games as game
    where game.id = gomoku_moves.game_id
      and (game.black_user_id = (select auth.uid()) or game.white_user_id = (select auth.uid()))
  )
);

-- These RPCs are only callable by the authenticated Edge Function using ctx.supabaseAdmin.
create or replace function public.gomoku_create_room(p_room_code text, p_user_id uuid, p_player_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.gomoku_games;
begin
  insert into public.gomoku_games (room_code, black_user_id, black_name)
  values (upper(p_room_code), p_user_id, trim(p_player_name))
  returning * into v_game;
  return to_jsonb(v_game);
end;
$$;

create or replace function public.gomoku_join_room(p_room_code text, p_user_id uuid, p_player_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.gomoku_games;
begin
  select * into v_game
  from public.gomoku_games
  where room_code = upper(trim(p_room_code))
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ROOM_NOT_FOUND';
  end if;
  if v_game.black_user_id = p_user_id or v_game.white_user_id = p_user_id then
    raise exception using errcode = 'P0001', message = 'ALREADY_IN_ROOM';
  end if;
  if v_game.status <> 'waiting' or v_game.white_user_id is not null then
    raise exception using errcode = 'P0001', message = 'ROOM_FULL';
  end if;

  update public.gomoku_games
  set white_user_id = p_user_id,
      white_name = trim(p_player_name),
      status = 'playing'
  where id = v_game.id
  returning * into v_game;

  return to_jsonb(v_game);
end;
$$;

create or replace function public.gomoku_submit_move(
  p_game_id uuid,
  p_user_id uuid,
  p_x integer,
  p_y integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.gomoku_games;
  v_move public.gomoku_moves;
  v_color text;
  v_move_number integer;
  v_direction integer;
  v_sign integer;
  v_step integer;
  v_dx integer[] := array[1, 0, 1, 1];
  v_dy integer[] := array[0, 1, 1, -1];
  v_count integer;
  v_won boolean := false;
  v_draw boolean := false;
  v_connected boolean;
begin
  if p_x is null or p_y is null or p_x < 0 or p_y < 0 or p_x > 14 or p_y > 14 then
    raise exception using errcode = 'P0001', message = 'OUT_OF_BOUNDS';
  end if;

  select * into v_game
  from public.gomoku_games
  where id = p_game_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GAME_NOT_FOUND';
  end if;
  if v_game.status <> 'playing' then
    raise exception using errcode = 'P0001', message = 'GAME_NOT_PLAYING';
  end if;

  if v_game.black_user_id = p_user_id then
    v_color := 'black';
  elsif v_game.white_user_id = p_user_id then
    v_color := 'white';
  else
    raise exception using errcode = 'P0001', message = 'NOT_A_PLAYER';
  end if;
  if v_game.current_turn <> v_color then
    raise exception using errcode = 'P0001', message = 'NOT_YOUR_TURN';
  end if;
  if exists (
    select 1 from public.gomoku_moves
    where game_id = p_game_id and x = p_x and y = p_y
  ) then
    raise exception using errcode = 'P0001', message = 'CELL_OCCUPIED';
  end if;

  select count(*)::integer + 1 into v_move_number
  from public.gomoku_moves where game_id = p_game_id;

  insert into public.gomoku_moves (game_id, user_id, color, x, y, move_number)
  values (p_game_id, p_user_id, v_color, p_x, p_y, v_move_number)
  returning * into v_move;

  for v_direction in 1..4 loop
    v_count := 1;
    for v_sign in -1..1 by 2 loop
      for v_step in 1..4 loop
        select exists (
          select 1
          from public.gomoku_moves
          where game_id = p_game_id
            and color = v_color
            and x = p_x + v_dx[v_direction] * v_step * v_sign
            and y = p_y + v_dy[v_direction] * v_step * v_sign
        ) into v_connected;
        exit when not v_connected;
        v_count := v_count + 1;
      end loop;
    end loop;
    if v_count >= 5 then
      v_won := true;
      exit;
    end if;
  end loop;

  v_draw := not v_won and v_move_number = 225;
  if v_won or v_draw then
    update public.gomoku_games
    set status = 'finished', winner = case when v_won then v_color else null end, finished_at = now()
    where id = p_game_id
    returning * into v_game;
  else
    update public.gomoku_games
    set current_turn = case when v_color = 'black' then 'white' else 'black' end
    where id = p_game_id
    returning * into v_game;
  end if;

  return jsonb_build_object('game', to_jsonb(v_game), 'move', to_jsonb(v_move));
end;
$$;

create or replace function public.gomoku_create_rematch(p_game_id uuid, p_room_code text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.gomoku_games;
  v_new public.gomoku_games;
begin
  select * into v_old
  from public.gomoku_games
  where id = p_game_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'GAME_NOT_FOUND';
  end if;
  if v_old.black_user_id <> p_user_id and v_old.white_user_id <> p_user_id then
    raise exception using errcode = 'P0001', message = 'NOT_A_PLAYER';
  end if;
  if v_old.status <> 'finished' then
    raise exception using errcode = 'P0001', message = 'GAME_NOT_FINISHED';
  end if;

  select * into v_new
  from public.gomoku_games
  where rematch_of_game_id = v_old.id;
  if found then
    return to_jsonb(v_new);
  end if;

  insert into public.gomoku_games (
    room_code, black_user_id, black_name, white_user_id, white_name,
    current_turn, status, rematch_of_game_id
  ) values (
    upper(p_room_code), v_old.black_user_id, v_old.black_name,
    v_old.white_user_id, v_old.white_name, 'black', 'playing', v_old.id
  )
  returning * into v_new;

  return to_jsonb(v_new);
end;
$$;

revoke all on function public.gomoku_create_room(text, uuid, text) from public, anon, authenticated;
revoke all on function public.gomoku_join_room(text, uuid, text) from public, anon, authenticated;
revoke all on function public.gomoku_submit_move(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.gomoku_create_rematch(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.gomoku_create_room(text, uuid, text) to service_role;
grant execute on function public.gomoku_join_room(text, uuid, text) to service_role;
grant execute on function public.gomoku_submit_move(uuid, uuid, integer, integer) to service_role;
grant execute on function public.gomoku_create_rematch(uuid, text, uuid) to service_role;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'gomoku_games'
  ) then
    alter publication supabase_realtime add table public.gomoku_games;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'gomoku_moves'
  ) then
    alter publication supabase_realtime add table public.gomoku_moves;
  end if;
end;
$$;
