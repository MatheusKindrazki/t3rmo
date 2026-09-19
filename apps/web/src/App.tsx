import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type Mode, type Tile, type RowWire, type FeedWire,
  type RoomSnapshot, type ServerMessage, WORD_LENGTH,
} from '@arena/core';
import { RoomSocket, loadClientId, loadName, saveName, type ConnStatus } from './lib/net.ts';
import { keyStates, tilePx, rankFromCuts } from './lib/game.ts';
import { Landing } from './components/Landing.tsx';
import { Vitals } from './components/Vitals.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Pulse } from './components/Pulse.tsx';
import { Leaderboard } from './components/Leaderboard.tsx';
import { Boards } from './components/Boards.tsx';
import { Keyboard } from './components/Keyboard.tsx';
import { CountdownVeil, RoundEndVeil, MatchEndVeil, LobbyVeil, DeadRoomVeil, WaitVeil, LeaveVeil } from './components/Overlays.tsx';
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
  /**
   * Five slots, not a string.
   *
   * A string forces letters to arrive left to right, which is not how people
   * solve: you often know the word ends in -ÃO, or that the third letter is an
   * R, long before you know the first. Slots let the cursor be placed anywhere
   * — by arrow key or by tapping the square — and let a letter be dropped into
   * the middle of an otherwise empty row.
   */
  draft: string[];
  cursor: number;
  shakeKey: number;
  /** Row index the shake belongs to, so it fires once and not on every later row. */
  shakeAt: number;
  top: RowWire[];
  hist: number[];
  online: number;
  solvedCount: number;
  feed: FeedWire[];
  me: [number, number, number] | null;
  spy: [string, string][];
  /** Percentile ladder sent instead of a personal rank in large rooms. */
  cuts: number[];
  /** True while `me` came from a `result`, i.e. the server addressed us by name. */
  exactRank: boolean;
  /** Rank before the last change, for the movement arrow. */
  prevRank: number;
  roundEnd: RoundEnd | null;
  matchEnd: { standings: RowWire[]; you: { rank: number; score: number } | null; answers: string[] } | null;
  toast: { msg: string; id: number } | null;
}

const EMPTY: State = {
  you: null, room: null, guesses: [], tiles: [], solved: [], finished: false,
  draft: ['', '', '', '', ''], cursor: 0, shakeKey: 0, shakeAt: -1,
  top: [], hist: [], online: 0, solvedCount: 0, feed: [],
  me: null, spy: [], cuts: [], exactRank: false, prevRank: 0, roundEnd: null, matchEnd: null, toast: null,
};

type Action =
  | { k: 'msg'; m: ServerMessage }
  | { k: 'type'; ch: string }
  | { k: 'back' }
  | { k: 'move'; to: number | 'left' | 'right' | 'home' | 'end' }
  | { k: 'toast'; msg: string }
  | { k: 'clearToast' };

const EMPTY_DRAFT = ['', '', '', '', ''];
const WL = WORD_LENGTH;

/** Next empty slot at or after `from`, wrapping once; -1 when the row is full. */
function nextGap(draft: string[], from: number): number {
  for (let i = 0; i < WL; i++) {
    const j = (from + i) % WL;
    if (!draft[j]) return j;
  }
  return -1;
}

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
      const at = s.cursor;
      const draft = [...s.draft];
      draft[at] = a.ch;
      // Advance to the next EMPTY slot rather than to at+1, so filling a gap in
      // the middle of a half-typed row lands you on the next gap instead of
      // overwriting the letter you already placed.
      const gap = nextGap(draft, at + 1);
      return { ...s, draft, cursor: gap === -1 ? Math.min(WL - 1, at + 1) : gap };
    }
    case 'back': {
      if (s.finished) return s;
      const draft = [...s.draft];
      // Clear under the cursor if there is something there; otherwise step back
      // and clear that. This is what every text field does and what the hand
      // expects, and it is the only way to delete the last letter of a full row
      // without the cursor having nowhere further to go.
      if (draft[s.cursor]) { draft[s.cursor] = ''; return { ...s, draft }; }
      const prev = Math.max(0, s.cursor - 1);
      draft[prev] = '';
      return { ...s, draft, cursor: prev };
    }
    case 'move': {
      if (s.finished || s.room?.phase !== 'playing') return s;
      const to = a.to;
      const at =
        to === 'left' ? Math.max(0, s.cursor - 1)
        : to === 'right' ? Math.min(WL - 1, s.cursor + 1)
        : to === 'home' ? 0
        : to === 'end' ? WL - 1
        : Math.max(0, Math.min(WL - 1, to));
      return { ...s, cursor: at };
    }
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
          const boards = m.room.cfg.b;
          const b = m.board;
          // Keep whatever is half-typed. `state` arrives on every (re)join, and
          // blanking the draft there meant a two-second blip cost you the word
          // you were in the middle of — the thing you least want to retype
          // under a clock. It is only cleared when the ROUND changed, where it
          // no longer belongs to anything.
          const sameRound = s.room?.round === m.room.round && s.guesses.length === (b?.guesses.length ?? 0);
          return {
            ...s,
            room: m.room,
            online: m.room.online,
            guesses: b?.guesses ?? [],
            tiles: b?.tiles ?? Array.from({ length: boards }, () => []),
            solved: b?.solved ?? new Array(boards).fill(false),
            finished: b?.finished ?? false,
            draft: sameRound ? s.draft : [...EMPTY_DRAFT],
            cursor: sameRound ? s.cursor : 0,
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
            draft: [...EMPTY_DRAFT], cursor: 0, shakeAt: -1,
            hist: new Array(m.maxGuesses).fill(0),
            solvedCount: 0,
            feed: [],
            spy: [],
            roundEnd: null,
            matchEnd: null,
          };

        case 'result': {
          if (!m.ok) {
            // shakeAt pins the shake to the row it belongs to. Gating on
            // `shakeKey > 0` meant that after a single rejection every later
            // row shook too — the player was told they had erred on every
            // correct guess for the rest of the round.
            return {
              ...s,
              shakeKey: s.shakeKey + 1,
              shakeAt: s.guesses.length,
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
            draft: [...EMPTY_DRAFT],
            cursor: 0,
            shakeAt: -1,
            me: [m.rank, m.score, m.guessesUsed],
            exactRank: m.rank > 0,
            prevRank: s.me?.[0] ?? 0,
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
            // A tick with no personal slice means the exact figure has aged out.
            exactRank: m.me ? true : s.cuts.length > 0 ? false : s.exactRank,
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
          return {
            ...s,
            room: m.room,
            // `answers` is being added to this frame server-side; read it
            // defensively so the client works against either version.
            matchEnd: {
              standings: m.standings,
              you: m.you,
              answers: (m as { answers?: string[] }).answers ?? s.roundEnd?.answers ?? [],
            },
            roundEnd: null,
          };

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
  /** Which rail the phone sheet is showing, if any. */
  const [sheet2, setSheet2] = useState<null | 'rank' | 'pulse'>(null);
  const [sheet, setSheet] = useState<null | 'rules' | 'progress'>(null);
  const [leaving, setLeaving] = useState(false);
  const recorded = useRef({ round: -1, match: -1 });
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const sock = useRef<RoomSocket | null>(null);
  /** Set while leaving on purpose, so the unload guard does not ask twice. */
  const leavingRef = useRef(false);

  const serverNow = useCallback(() => sock.current?.serverNow() ?? Date.now(), []);

  /* ------------------------------------------------------------ connection */

  const enter = useCallback((code: string, nick: string, isNew = false) => {
    sock.current?.close();
    const s = new RoomSocket(code, nick || 'anon', loadClientId(), isNew);
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
      enter(code, name, true);
      // Queued, not timed. The socket buffers this until it is open and the
      // join has gone out — a 250ms timer lost the host's chosen format every
      // time the connection took longer than that, which over the real edge is
      // often.
      sock.current?.send({ t: 'config', mode, rounds });
    } catch (e) {
      setError(`não consegui abrir a sala: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [name, enter]);

  const join = useCallback(async (code: string) => {
    const up = code.toUpperCase();
    saveName(name);
    setError(null);
    setBusy(true);
    try {
      // Ask before connecting. Connecting first would CREATE the room, which is
      // exactly the bug: a typo made you the host of an empty lobby identical
      // to the one you meant to join.
      const res = await fetch(`/api/rooms/${encodeURIComponent(up)}/info`);
      if (res.ok) {
        const info = (await res.json()) as { created?: boolean };
        if (info.created === false) {
          setError(`a sala ${up} não existe — confira o código`);
          return;
        }
      }
    } catch {
      // A failed check is not proof the room is missing; let the socket try.
    } finally {
      setBusy(false);
    }
    enter(up, name);
  }, [name, enter]);

  // Deep link: /?sala=A7X drops you straight into the room.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('sala');
    if (code && !sock.current) enter(code.toUpperCase(), loadName() || 'anon');
  }, [enter]);

  /** The app had no exit at all: `st.room` was never set back to null, so a
   *  dead room could only be escaped by editing the URL. */
  const leave = useCallback(() => {
    leavingRef.current = true;
    sock.current?.close();
    sock.current = null;
    const url = new URL(location.href);
    url.searchParams.delete('sala');
    history.replaceState(null, '', url);
    location.reload();
  }, []);

  /**
   * The in-app exit is the polite door; the tab close is the one people
   * actually walk through by accident. The browser only honours this while a
   * round is genuinely live, and only after the player has interacted with the
   * page — which by definition they have, because they typed a guess.
   */
  useEffect(() => {
    const live = st.room?.phase === 'playing' || st.room?.phase === 'countdown';
    if (!live) return;
    if (leavingRef.current) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [st.room?.phase]);

  useEffect(() => () => sock.current?.close(), []);
  useEffect(() => {
    const onResize = () => { setVh(window.innerHeight); setVw(window.innerWidth); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ------------------------------------------------------------ input */

  const submit = useCallback(() => {
    const word = st.draft.join('');
    if (word.length !== WORD_LENGTH) {
      dispatch({ k: 'toast', msg: 'faltam letras' });
      return;
    }
    sock.current?.guess(word);
  }, [st.draft]);

  const onKey = useCallback((k: string) => {
    if (k === 'ENTER') return submit();
    if (k === 'BACK') return dispatch({ k: 'back' });
    dispatch({ k: 'type', ch: k });
  }, [submit]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;

      // Text entry owns every key: never steal from a field.
      if (el?.closest?.('input, textarea, select, [contenteditable]')) return;

      // Buttons own only their ACTIVATION keys.
      //
      // The first version of this guard bailed on buttons entirely, which fixed
      // one bug and caused another: checking only INPUT/TEXTAREA meant a
      // keydown on a <button> bubbled to window and got preventDefault()ed, so
      // Enter activated no button anywhere in the app — but bailing on the
      // whole element meant that after tapping a draft square or an on-screen
      // key (both buttons, both of which take focus) typing did nothing at all.
      // Enter and Space belong to the focused control; letters and arrows
      // belong to the game.
      const onControl = !!el?.closest?.('button, [href], [role="button"]');
      if (onControl && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) return;
      if (e.key === 'Enter') { e.preventDefault(); return submit(); }
      if (e.key === 'Backspace') { e.preventDefault(); return dispatch({ k: 'back' }); }
      if (e.key === 'Delete') { e.preventDefault(); return dispatch({ k: 'back' }); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); return dispatch({ k: 'move', to: 'left' }); }
      if (e.key === 'ArrowRight') { e.preventDefault(); return dispatch({ k: 'move', to: 'right' }); }
      if (e.key === 'Home') { e.preventDefault(); return dispatch({ k: 'move', to: 'home' }); }
      if (e.key === 'End') { e.preventDefault(); return dispatch({ k: 'move', to: 'end' }); }
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
      boards: st.room.cfg.b,
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

  // On a phone the drawer hides the whole play column, veils included. Leaving
  // it open through an intermission meant missing the reveal, the countdown and
  // the match end entirely — and the intermission is exactly when a player
  // opens the ranking.
  useEffect(() => {
    if (st.room && st.room.phase !== 'playing') setSheet2(null);
  }, [st.room?.phase]);

  useEffect(() => {
    if (!st.toast) return;
    const t = setTimeout(() => dispatch({ k: 'clearToast' }), 1500);
    return () => clearTimeout(t);
  }, [st.toast]);

  /* ------------------------------------------------------------ render */

  /**
   * The round's shape comes off the wire, not off the mode.
   *
   * In MISTO the format changes every round — round 1 is TERMO and round 4 is
   * QUARTETO — so `MODES[room.mode]` is the wrong answer three times out of
   * four. It said one board of six rows while the server was running four
   * boards of nine, and the player simply could not see three of the words
   * they were being scored on. The server publishes the effective config in
   * every snapshot; this reads it.
   */
  const cfg = st.room
    ? { boards: st.room.cfg.b, maxGuesses: st.room.cfg.g, label: st.room.cfg.l }
    : null;
  const ks = useMemo(
    () => keyStates(st.guesses, st.tiles, cfg?.boards ?? 1),
    [st.guesses, st.tiles, cfg?.boards],
  );
  const tile = useMemo(
    () => (cfg ? tilePx(cfg.boards, cfg.maxGuesses, vw, vh) : 56),
    [cfg?.boards, cfg?.maxGuesses, vw, vh],
  );

  // In a big room the frame carries a percentile ladder instead of a personal
  // slice — but a `result` still carries the player's EXACT rank, and throwing
  // that away to re-derive "~250" from a 14-step ladder broke the contract
  // protocol.ts states and the promise the UI prints. Exact wins while it is
  // fresh; the ladder only fills the gap between guesses.
  const exact = st.me !== null && st.me[0] > 0 && st.exactRank;
  const approx = st.cuts.length > 0 && !exact;
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
  // Derived every frame, not frozen at welcome. The server reassigns the host
  // when one leaves, and RoomSnapshot.hostPrefix carries enough to recognise it —
  // welcome-time flag meant a promoted player was shown "aguardando quem criou
  // a sala" and no button, while the server would have accepted their start.
  // Compared by PREFIX, because the wire no longer carries the full host id —
  // exposing it let a spectator hijack the room. `welcome.you.isHost` is the
  // authoritative bootstrap; this keeps it correct across host reassignment
  // without ever needing the whole id.
  const isHost = st.room.hostPrefix !== null && st.room.hostPrefix === st.you?.id.slice(0, 8);
  return (
    <div className="shell">
      <TopBar
        room={st.room} online={st.online} myRank={myRank} prevRank={st.prevRank} approx={approx} serverNow={serverNow}
        onRules={() => setSheet('rules')} onProgress={() => setSheet('progress')}
        onLeave={() => setLeaving(true)}
      />

      <Vitals
        online={st.online} solved={st.solvedCount} rank={myRank} approx={approx}
        onOpen={(w) => setSheet2((cur) => (cur === w ? null : w))}
      />

      <div className="stage" data-sheet={sheet2 ?? undefined}>
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
              cursor={st.cursor}
              onPick={(i) => dispatch({ k: 'move', to: i })}
              shakeKey={st.shakeKey}
              shakeAt={st.shakeAt}
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
              isHost={isHost}
              code={st.room.code}
              onStart={() => sock.current?.send({ t: 'start' })}
            />
          )}
          {phase === 'countdown' && <CountdownVeil deadline={st.room.deadline} serverNow={serverNow} />}
          {phase === 'intermission' && (st.roundEnd
            ? <RoundEndVeil {...st.roundEnd} />
            : <WaitVeil deadline={st.room.deadline} serverNow={serverNow} />)}
          {phase === 'finished' && (st.matchEnd
            ? <MatchEndVeil
                standings={st.matchEnd.standings}
                you={st.matchEnd.you}
                answers={st.matchEnd.answers}
                isHost={isHost}
                onAgain={() => sock.current?.send({ t: 'start' })}
              />
            : <DeadRoomVeil code={st.room.code} onLeave={leave} />)}
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

      {leaving && (
        <LeaveVeil
          phase={phase} round={st.room.round || 1} rounds={st.room.rounds} rank={myRank}
          onCancel={() => setLeaving(false)}
          onConfirm={leave}
        />
      )}
      {sheet === 'rules' && <Rules onClose={() => setSheet(null)} />}
      {sheet === 'progress' && <Progress mode={st.room.mode} onClose={() => setSheet(null)} />}

      {st.toast && <div className="toast" data-tone="bad" key={st.toast.id} role="status">{st.toast.msg}</div>}
      {conn !== 'open' && conn !== 'idle' && conn !== 'taken' && (
        <div className="toast" data-tone="bad" role="status">
          {conn === 'connecting' ? 'CONECTANDO…' : 'SEM CONEXÃO'}
        </div>
      )}
      {conn === 'taken' && (
        <div className="veil" role="alertdialog" aria-modal="true">
          <div className="veil-box">
            <div className="kicker">sala {st.room.code}</div>
            <div className="vtitle">Você abriu esta sala<br />em outra aba</div>
            <p className="hint" style={{ marginTop: 12, maxWidth: 360, marginInline: 'auto' }}>
              Só uma aba por jogador — a outra continua jogando com a sua posição.
              Pode trazer a partida de volta para cá.
            </p>
            <button className="btn" style={{ marginTop: 20 }} onClick={() => sock.current?.reclaim()}>
              jogar aqui
            </button>
          </div>
        </div>
      )}
      {sheet2 && (
        <div className="sheet-bar">
          <button className="sheet-tab" data-on={sheet2 === 'rank'} onClick={() => setSheet2('rank')}>ranking</button>
          <button className="sheet-tab" data-on={sheet2 === 'pulse'} onClick={() => setSheet2('pulse')}>pulso</button>
          <button className="sheet-x" onClick={() => setSheet2(null)} aria-label="voltar ao jogo">voltar ao jogo</button>
        </div>
      )}
    </div>
  );
}
