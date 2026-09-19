import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  MODES, type Mode, type Tile, type RowWire, type FeedWire,
  type RoomSnapshot, type ServerMessage, WORD_LENGTH,
} from '@arena/core';
import { RoomSocket, loadClientId, loadName, saveName, type ConnStatus } from './lib/net.ts';
import { keyStates, tilePx, rankFromCuts } from './lib/game.ts';
import { Landing } from './components/Landing.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Pulse } from './components/Pulse.tsx';
import { Leaderboard } from './components/Leaderboard.tsx';
import { Boards } from './components/Boards.tsx';
import { Keyboard } from './components/Keyboard.tsx';
import { CountdownVeil, RoundEndVeil, MatchEndVeil, LobbyVeil } from './components/Overlays.tsx';
import { Rules } from './components/Rules.tsx';
import { Progress } from './components/Progress.tsx';
import { recordRound, recordMatch } from './lib/stats.ts';

interface RoundEnd {
  answers: string[];
  you: { score: number; rank: number; solvedWords: number; guesses: number; roundScore: number } | null;
  podium: RowWire[];
  round: number;
  rounds: number;
}

interface State {
  you: { id: string; name: string; isHost: boolean } | null;
  room: RoomSnapshot | null;
  guesses: string[];
  tiles: Tile[][][];
  solved: boolean[];
  finished: boolean;
  draft: string;
  shakeKey: number;
  top: RowWire[];
  hist: number[];
  online: number;
  solvedCount: number;
  feed: FeedWire[];
  me: [number, number, number] | null;
  spy: [string, string][];
  /** Percentile ladder sent instead of a personal rank in large rooms. */
  cuts: number[];
  roundEnd: RoundEnd | null;
  matchEnd: { standings: RowWire[]; you: { rank: number; score: number } | null } | null;
  toast: { msg: string; id: number } | null;
}

const EMPTY: State = {
  you: null, room: null, guesses: [], tiles: [], solved: [], finished: false,
  draft: '', shakeKey: 0, top: [], hist: [], online: 0, solvedCount: 0, feed: [],
  me: null, spy: [], cuts: [], roundEnd: null, matchEnd: null, toast: null,
};

type Action =
  | { k: 'msg'; m: ServerMessage }
  | { k: 'type'; ch: string }
  | { k: 'back' }
  | { k: 'toast'; msg: string }
  | { k: 'clearToast' };

const REJECTION: Record<string, string> = {
  'unknown-word': 'palavra não encontrada',
  'too-fast': 'devagar',
  'duplicate': 'você já tentou essa',
  'closed': 'rodada fechada',
};

function reduce(s: State, a: Action): State {
  switch (a.k) {
    case 'type': {
      if (s.finished || s.room?.phase !== 'playing') return s;
      if (s.draft.length >= WORD_LENGTH) return s;
      return { ...s, draft: s.draft + a.ch };
    }
    case 'back':
      return s.draft ? { ...s, draft: s.draft.slice(0, -1) } : s;
    case 'toast':
      return { ...s, toast: { msg: a.msg, id: Date.now() } };
    case 'clearToast':
      return { ...s, toast: null };

    case 'msg': {
      const m = a.m;
      switch (m.t) {
        case 'welcome':
          return { ...s, you: m.you, room: m.room, online: m.room.online };

        case 'state': {
          const boards = MODES[m.room.mode].boards;
          const b = m.board;
          return {
            ...s,
            room: m.room,
            online: m.room.online,
            guesses: b?.guesses ?? [],
            tiles: b?.tiles ?? Array.from({ length: boards }, () => []),
            solved: b?.solved ?? new Array(boards).fill(false),
            finished: b?.finished ?? false,
            draft: '',
          };
        }

        case 'roundStart':
          return {
            ...s,
            room: m.room,
            guesses: [],
            tiles: Array.from({ length: m.boards }, () => []),
            solved: new Array(m.boards).fill(false),
            finished: false,
            draft: '',
            hist: new Array(m.maxGuesses).fill(0),
            solvedCount: 0,
            feed: [],
            spy: [],
            roundEnd: null,
            matchEnd: null,
          };

        case 'result': {
          if (!m.ok) {
            return {
              ...s,
              shakeKey: s.shakeKey + 1,
              toast: { msg: REJECTION[m.reason] ?? m.reason, id: Date.now() },
            };
          }
          // One submitted word appends one row to every board at once.
          const tiles = s.tiles.map((board, b) => [...board, m.tiles[b] ?? []]);
          return {
            ...s,
            guesses: [...s.guesses, m.word],
            tiles,
            solved: m.solved,
            finished: m.finished,
            draft: '',
            me: [m.rank, m.score, m.guessesUsed],
          };
        }

        case 'tick':
          return {
            ...s,
            online: m.online,
            solvedCount: m.solved,
            hist: m.hist,
            top: m.top,
            feed: m.feed.length ? [...s.feed, ...m.feed].slice(-30) : s.feed,
            spy: m.spy ?? s.spy,
            cuts: m.cuts ?? [],
            // In a large room the frame carries no personal slice; the exact
            // figure still arrives with every `result`, and between guesses the
            // ladder places the player.
            me: m.me ?? s.me,
            room: s.room ? { ...s.room, online: m.online } : s.room,
          };

        case 'roundEnd':
          return {
            ...s,
            room: m.room,
            roundEnd: { answers: m.answers, you: m.you, podium: m.podium, round: m.room.round, rounds: m.room.rounds },
          };

        case 'matchEnd':
          return { ...s, room: m.room, matchEnd: { standings: m.standings, you: m.you }, roundEnd: null };

        case 'page':
          return s;

        case 'error':
          return { ...s, toast: { msg: m.message, id: Date.now() } };

        default:
          return s;
      }
    }
  }
}

export default function App() {
  const [st, dispatch] = useReducer(reduce, EMPTY);
  const [name, setName] = useState(() => loadName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnStatus>('idle');
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState<null | 'rules' | 'progress'>(null);
  const recorded = useRef({ round: -1, match: -1 });
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const sock = useRef<RoomSocket | null>(null);

  const serverNow = useCallback(() => sock.current?.serverNow() ?? Date.now(), []);

  /* ------------------------------------------------------------ connection */

  const enter = useCallback((code: string, nick: string) => {
    sock.current?.close();
    const s = new RoomSocket(code, nick || 'anon', loadClientId());
    s.on((m) => dispatch({ k: 'msg', m }));
    s.onStatus(setConn);
    s.connect();
    sock.current = s;
    const url = new URL(location.href);
    url.searchParams.set('sala', code);
    history.replaceState(null, '', url);
  }, []);

  const create = useCallback(async (mode: Mode, rounds: number) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error(`servidor respondeu ${res.status}`);
      const { code } = (await res.json()) as { code: string };
      saveName(name);
      enter(code, name);
      // The room is created in lobby; the host picks the format from here.
      setTimeout(() => sock.current?.send({ t: 'config', mode, rounds }), 250);
    } catch (e) {
      setError(`não consegui abrir a sala: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [name, enter]);

  const join = useCallback((code: string) => {
    saveName(name);
    setError(null);
    enter(code.toUpperCase(), name);
  }, [name, enter]);

  // Deep link: /?sala=A7X drops you straight into the room.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('sala');
    if (code && !sock.current) enter(code.toUpperCase(), loadName() || 'anon');
  }, [enter]);

  useEffect(() => () => sock.current?.close(), []);
  useEffect(() => {
    const onResize = () => { setVh(window.innerHeight); setVw(window.innerWidth); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ------------------------------------------------------------ input */

  const submit = useCallback(() => {
    if (st.draft.length !== WORD_LENGTH) {
      dispatch({ k: 'toast', msg: 'faltam letras' });
      return;
    }
    sock.current?.guess(st.draft);
  }, [st.draft]);

  const onKey = useCallback((k: string) => {
    if (k === 'ENTER') return submit();
    if (k === 'BACK') return dispatch({ k: 'back' });
    dispatch({ k: 'type', ch: k });
  }, [submit]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter') { e.preventDefault(); return submit(); }
      if (e.key === 'Backspace') { e.preventDefault(); return dispatch({ k: 'back' }); }
      const ch = e.key.toUpperCase();
      if (/^[A-ZÇ]$/.test(ch)) { e.preventDefault(); dispatch({ k: 'type', ch }); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [submit]);

  /**
   * Personal record is written once per round, guarded by the round index.
   * roundEnd re-renders for other reasons (the clock, a late tick), and without
   * the guard a single round would be counted several times.
   */
  useEffect(() => {
    const re = st.roundEnd;
    if (!re || !re.you || !st.room) return;
    if (recorded.current.round === re.round) return;
    recorded.current.round = re.round;
    recordRound(st.room.mode, {
      solvedWords: re.you.solvedWords,
      boards: MODES[st.room.mode].boards,
      guesses: re.you.guesses,
      rank: re.you.rank,
    });
  }, [st.roundEnd, st.room?.mode]);

  useEffect(() => {
    const me = st.matchEnd;
    if (!me || !me.you || !st.room) return;
    const stamp = st.room.round * 1000 + me.you.rank;
    if (recorded.current.match === stamp) return;
    recorded.current.match = stamp;
    recordMatch(st.room.mode, me.you.rank);
  }, [st.matchEnd, st.room?.mode]);

  useEffect(() => {
    if (!st.toast) return;
    const t = setTimeout(() => dispatch({ k: 'clearToast' }), 1500);
    return () => clearTimeout(t);
  }, [st.toast]);

  /* ------------------------------------------------------------ render */

  const cfg = st.room ? MODES[st.room.mode] : null;
  const ks = useMemo(
    () => keyStates(st.guesses, st.tiles, cfg?.boards ?? 1),
    [st.guesses, st.tiles, cfg?.boards],
  );
  const tile = useMemo(
    () => (cfg ? tilePx(cfg.boards, cfg.maxGuesses, vw, vh) : 56),
    [cfg?.boards, cfg?.maxGuesses, vw, vh],
  );

  // Exact when the server addressed us personally; estimated from the ladder
  // otherwise. The UI marks the difference rather than hiding it.
  const approx = st.cuts.length > 0;
  const myRank = approx && st.me ? rankFromCuts(st.me[1], st.cuts, st.online) : (st.me?.[0] ?? 0);

  if (!st.room || !cfg) {
    return (
      <>
        <Landing
          name={name} setName={setName} onCreate={create} onJoin={join}
          busy={busy || conn === 'connecting'} error={error}
          onRules={() => setSheet('rules')} onProgress={() => setSheet('progress')}
        />
        {conn === 'connecting' && <div className="toast">CONECTANDO…</div>}
        {sheet === 'rules' && <Rules onClose={() => setSheet(null)} />}
        {sheet === 'progress' && <Progress mode="termo" onClose={() => setSheet(null)} />}
      </>
    );
  }

  const phase = st.room.phase;
  return (
    <div className="shell">
      <TopBar
        room={st.room} online={st.online} myRank={myRank} approx={approx} serverNow={serverNow}
        onRules={() => setSheet('rules')} onProgress={() => setSheet('progress')}
      />

      <div className="stage" data-drawer={drawer}>
        <Pulse
          online={st.online}
          solved={st.solvedCount}
          hist={st.hist.length ? st.hist : new Array(cfg.maxGuesses).fill(0)}
          feed={st.feed}
          myGuesses={st.guesses.length}
        />

        <main className="play">
          <div className="col">
          <div className="boards-wrap">
            <Boards
              boards={cfg.boards}
              maxGuesses={cfg.maxGuesses}
              guesses={st.guesses}
              tiles={st.tiles}
              solved={st.solved}
              draft={st.draft}
              shakeKey={st.shakeKey}
              tile={tile}
            />
          </div>
          <Keyboard
            states={ks}
            boards={cfg.boards}
            onKey={onKey}
            disabled={phase !== 'playing' || st.finished}
          />
          </div>

          {phase === 'lobby' && (
            <LobbyVeil
              online={st.online}
              isHost={st.you?.isHost ?? false}
              code={st.room.code}
              onStart={() => sock.current?.send({ t: 'start' })}
            />
          )}
          {phase === 'countdown' && <CountdownVeil deadline={st.room.deadline} serverNow={serverNow} />}
          {phase === 'intermission' && st.roundEnd && <RoundEndVeil {...st.roundEnd} />}
          {phase === 'finished' && st.matchEnd && (
            <MatchEndVeil
              standings={st.matchEnd.standings}
              you={st.matchEnd.you}
              isHost={st.you?.isHost ?? false}
              onAgain={() => sock.current?.send({ t: 'start' })}
            />
          )}
        </main>

        <Leaderboard
          top={st.top}
          spy={st.spy}
          maxGuesses={cfg.maxGuesses}
          me={st.me ? [myRank, st.me[1], st.me[2]] : null}
          myName={st.you?.name ?? 'você'}
          myId={st.you?.id ?? ''}
          total={st.online}
          approx={approx}
        />
      </div>

      {sheet === 'rules' && <Rules onClose={() => setSheet(null)} />}
      {sheet === 'progress' && <Progress mode={st.room.mode} onClose={() => setSheet(null)} />}

      {st.toast && <div className="toast" data-tone="bad" key={st.toast.id} role="status">{st.toast.msg}</div>}
      {conn === 'closed' && <div className="toast" data-tone="bad" role="status">RECONECTANDO…</div>}
      <button className="tab-r" onClick={() => setDrawer((d) => !d)}>
        {drawer ? 'VOLTAR AO JOGO' : 'RANKING'}
      </button>
    </div>
  );
}
