// RoomTerminal — collaborative brainstorm room.
//
// Mounted by /room/index.astro as a client-only React island. Reads the room
// slug from `?id=<slug>` (or `/room/<slug>` when a Vercel rewrite is in
// play). Talks to Supabase directly: Postgres for persisted state, Realtime
// for live sync.
//
// UI is chat-styled with per-phase buttons (no command-line). Look and feel
// stays terminal: mono font, thin borders, `[ ]` bracket buttons, CSS
// variables for theming.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { hasSupabaseEnv, makeRoomClient, ROOM_SESSION_KEY } from "../lib/room/client";
import { generateToken } from "../lib/room/slug";
import { loadRoomDict, makeT, type RoomDict } from "../lib/room/strings";
import { buildBriefMarkdown } from "../lib/room/markdown";
import type {
  Assessment,
  AssessmentKind,
  Idea,
  Locale,
  Participant,
  Persona,
  Phase,
  Room,
  RoomState,
  Scope,
  SessionData,
  StreamLine,
  Verdict,
  Vote,
} from "../lib/room/types";

// ---------- Slug + session helpers ----------

function extractSlug(): string | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.replace(/\/+$/, "");
  const m = path.match(/^\/room\/([a-z0-9-]+)$/i);
  if (m) return m[1].toLowerCase();
  try {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) return id.toLowerCase();
  } catch {}
  return null;
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6);
}

function loadSession(slug: string): SessionData | null {
  try {
    const raw = localStorage.getItem(ROOM_SESSION_KEY(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.sessionToken !== "string") return null;
    return parsed as SessionData;
  } catch {
    return null;
  }
}

function saveSession(slug: string, data: SessionData): void {
  try { localStorage.setItem(ROOM_SESSION_KEY(slug), JSON.stringify(data)); } catch {}
}

function clearSession(slug: string): void {
  try { localStorage.removeItem(ROOM_SESSION_KEY(slug)); } catch {}
}

function isHandleValid(h: string): boolean {
  return /^[a-zA-Z0-9_-]{2,32}$/.test(h.replace(/^@/, ""));
}

function newLine(kind: StreamLine["kind"], text: string): StreamLine {
  return { id: Math.random().toString(36).slice(2), kind, text, ts: Date.now() };
}

// Relative time: "now", "2m", "15m", "1h", "3h", or HH:MM for older.
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 5) return "now";
  if (diffSec < 60) return `${Math.floor(diffSec)}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 3600 * 6) return `${Math.floor(diffSec / 3600)}h`;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function aliveCount(state: RoomState): number {
  const cutoff = Date.now() - 60_000;
  let n = 0;
  for (const p of state.participants.values()) {
    if (new Date(p.last_seen_at).getTime() > cutoff) n++;
  }
  return n;
}

function readyAliveCount(state: RoomState): number {
  const cutoff = Date.now() - 60_000;
  let n = 0;
  for (const p of state.participants.values()) {
    if (p.ready && new Date(p.last_seen_at).getTime() > cutoff) n++;
  }
  return n;
}

// ---------- Reducer ----------

type Action =
  | { type: "SET_ROOM"; room: Room }
  | { type: "UPSERT_PARTICIPANT"; p: Participant }
  | { type: "REMOVE_PARTICIPANT"; sessionToken: string }
  | { type: "UPSERT_IDEA"; idea: Idea }
  | { type: "REMOVE_IDEA"; id: string }
  | { type: "UPSERT_VOTE"; vote: Vote }
  | { type: "REMOVE_VOTE"; v: Pick<Vote, "session_token" | "idea_id" | "phase"> }
  | { type: "UPSERT_ASSESSMENT"; a: Assessment }
  | { type: "REMOVE_ASSESSMENT"; id: string }
  | { type: "SET_PERSONA"; p: Persona | null }
  | { type: "SET_SCOPE"; s: Scope | null }
  | { type: "HYDRATE"; snapshot: HydrateSnapshot }
  | { type: "APPEND_TOAST"; line: StreamLine }
  | { type: "CLEAR_TOASTS" };

interface HydrateSnapshot {
  room: Room;
  participants: Participant[];
  ideas: Idea[];
  votes: Vote[];
  assessments: Assessment[];
  persona: Persona | null;
  scope: Scope | null;
}

function initialState(): RoomState {
  return {
    room: null,
    participants: new Map(),
    ideas: new Map(),
    votes: [],
    assessments: new Map(),
    persona: null,
    scope: null,
    stream: [],
  };
}

function reducer(state: RoomState, action: Action): RoomState {
  switch (action.type) {
    case "SET_ROOM":
      return { ...state, room: action.room };
    case "UPSERT_PARTICIPANT": {
      const m = new Map(state.participants);
      m.set(action.p.session_token, action.p);
      return { ...state, participants: m };
    }
    case "REMOVE_PARTICIPANT": {
      const m = new Map(state.participants);
      m.delete(action.sessionToken);
      return { ...state, participants: m };
    }
    case "UPSERT_IDEA": {
      const m = new Map(state.ideas);
      m.set(action.idea.id, action.idea);
      return { ...state, ideas: m };
    }
    case "REMOVE_IDEA": {
      const m = new Map(state.ideas);
      m.delete(action.id);
      return { ...state, ideas: m };
    }
    case "UPSERT_VOTE": {
      const filtered = state.votes.filter(
        (v) => !(v.session_token === action.vote.session_token && v.idea_id === action.vote.idea_id && v.phase === action.vote.phase)
      );
      return { ...state, votes: [...filtered, action.vote] };
    }
    case "REMOVE_VOTE":
      return {
        ...state,
        votes: state.votes.filter(
          (v) => !(v.session_token === action.v.session_token && v.idea_id === action.v.idea_id && v.phase === action.v.phase)
        ),
      };
    case "UPSERT_ASSESSMENT": {
      const m = new Map(state.assessments);
      m.set(action.a.id, action.a);
      return { ...state, assessments: m };
    }
    case "REMOVE_ASSESSMENT": {
      const m = new Map(state.assessments);
      m.delete(action.id);
      return { ...state, assessments: m };
    }
    case "SET_PERSONA":
      return { ...state, persona: action.p };
    case "SET_SCOPE":
      return { ...state, scope: action.s };
    case "HYDRATE": {
      const s = action.snapshot;
      const participants = new Map<string, Participant>();
      s.participants.forEach((p) => participants.set(p.session_token, p));
      const ideas = new Map<string, Idea>();
      s.ideas.forEach((i) => ideas.set(i.id, i));
      const assessments = new Map<string, Assessment>();
      s.assessments.forEach((a) => assessments.set(a.id, a));
      return {
        ...state,
        room: s.room,
        participants,
        ideas,
        votes: s.votes,
        assessments,
        persona: s.persona,
        scope: s.scope,
      };
    }
    case "APPEND_TOAST":
      return { ...state, stream: state.stream.concat(action.line).slice(-8) };
    case "CLEAR_TOASTS":
      return { ...state, stream: [] };
  }
}

// ---------- Component ----------

export default function RoomTerminal() {
  const slug = useMemo(extractSlug, []);
  const [phaseStatus, setPhaseStatus] = useState<"loading" | "ready" | "not_found" | "expired" | "no_env">("loading");
  const [session, setSession] = useState<SessionData | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  // The realtime callbacks set up in a useEffect close over state at effect
  // time; without a ref they'd report stale data. Updated every render.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const [pendingHandle, setPendingHandle] = useState("");
  const [pendingHandleError, setPendingHandleError] = useState<string | null>(null);

  const dict: RoomDict = useMemo(
    () => loadRoomDict((state.room?.locale as Locale) ?? "en"),
    [state.room?.locale]
  );
  const t = useMemo(() => makeT(dict), [dict]);

  const toast = useCallback((kind: StreamLine["kind"], text: string) => {
    dispatch({ type: "APPEND_TOAST", line: newLine(kind, text) });
  }, []);

  // Auto-dismiss toasts after 4s.
  useEffect(() => {
    if (state.stream.length === 0) return;
    const handle = window.setTimeout(() => {
      dispatch({ type: "APPEND_TOAST", line: newLine("muted", "") });
      dispatch({ type: "CLEAR_TOASTS" });
    }, 4000);
    return () => window.clearTimeout(handle);
  }, [state.stream.length]);

  // ----- Bootstrap: discover slug + session + load room

  useEffect(() => {
    if (!slug) { setPhaseStatus("not_found"); return; }
    if (!hasSupabaseEnv()) { setPhaseStatus("no_env"); return; }
    let cancelled = false;

    (async () => {
      const existing = loadSession(slug);
      let sess = existing;
      if (!sess) {
        sess = { sessionToken: generateToken(), handle: null };
        saveSession(slug, sess);
      }
      const c = makeRoomClient({ sessionToken: sess.sessionToken, hostToken: sess.hostToken });
      const { data, error } = await c.from("rooms").select("*").eq("slug", slug).maybeSingle();
      if (cancelled) return;
      if (error || !data) { setPhaseStatus("not_found"); return; }
      const room = data as Room;
      if (new Date(room.expires_at).getTime() <= Date.now()) {
        setPhaseStatus("expired");
        return;
      }
      setSession(sess);
      setClient(c);
      dispatch({ type: "SET_ROOM", room });
      setPhaseStatus("ready");
    })();

    return () => { cancelled = true; };
  }, [slug]);

  // ----- Subscribe + heartbeat after the user has a handle.

  useEffect(() => {
    if (phaseStatus !== "ready" || !client || !session || !state.room || !session.handle) return;
    const room = state.room;
    let cancelled = false;

    (async () => {
      await client.from("room_participants").upsert(
        {
          room_id: room.id,
          session_token: session.sessionToken,
          handle: session.handle!,
          last_seen_at: new Date().toISOString(),
          ready: false,
        },
        { onConflict: "room_id,session_token" }
      );

      const [participantsR, ideasR, votesR, assessmentsR, personaR, scopeR] = await Promise.all([
        client.from("room_participants").select("*").eq("room_id", room.id),
        client.from("room_ideas").select("*").eq("room_id", room.id),
        client.from("room_votes").select("*").eq("room_id", room.id),
        client.from("room_assessments").select("*").eq("room_id", room.id),
        client.from("room_personas").select("*").eq("room_id", room.id).maybeSingle(),
        client.from("room_scopes").select("*").eq("room_id", room.id).maybeSingle(),
      ]);
      if (cancelled) return;

      dispatch({
        type: "HYDRATE",
        snapshot: {
          room,
          participants: (participantsR.data as Participant[]) ?? [],
          ideas: (ideasR.data as Idea[]) ?? [],
          votes: (votesR.data as Vote[]) ?? [],
          assessments: (assessmentsR.data as Assessment[]) ?? [],
          persona: (personaR.data as Persona) ?? null,
          scope: (scopeR.data as Scope) ?? null,
        },
      });

      const channel = client.channel(`room:${room.slug}`, {
        config: { presence: { key: session.sessionToken }, broadcast: { self: false } },
      });
      channelRef.current = channel;
      const tableFilter = `room_id=eq.${room.id}`;

      channel
        .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.id}` }, (payload) => {
          if (payload.eventType === "DELETE") { setPhaseStatus("expired"); return; }
          const newRoom = payload.new as Room;
          const prev = stateRef.current.room;
          dispatch({ type: "SET_ROOM", room: newRoom });
          if (prev && prev.phase !== newRoom.phase) {
            if (prev.phase === "assess" && newRoom.phase === "brainstorm") {
              toast("muted", t("stream.phase_back_to_brainstorm"));
            }
            toast("success", t("stream.phase_advanced", { phase: t("phase." + newRoom.phase) }));
          }
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_participants", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as Participant;
            dispatch({ type: "REMOVE_PARTICIPANT", sessionToken: old.session_token });
            toast("muted", t("stream.left", { handle: "@" + old.handle }));
            return;
          }
          const p = payload.new as Participant;
          const before = stateRef.current.participants.get(p.session_token);
          dispatch({ type: "UPSERT_PARTICIPANT", p });
          if (!before && p.session_token !== session.sessionToken) {
            toast("info", t("stream.joined", { handle: "@" + p.handle }));
          }
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_ideas", filter: tableFilter }, (payload) => {
          dispatch({ type: "UPSERT_IDEA", idea: payload.new as Idea });
        })
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "room_ideas", filter: tableFilter }, (payload) => {
          dispatch({ type: "REMOVE_IDEA", id: (payload.old as Idea).id });
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_votes", filter: tableFilter }, (payload) => {
          dispatch({ type: "UPSERT_VOTE", vote: payload.new as Vote });
        })
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "room_votes", filter: tableFilter }, (payload) => {
          dispatch({ type: "REMOVE_VOTE", v: payload.old as Vote });
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_assessments", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") {
            dispatch({ type: "REMOVE_ASSESSMENT", id: (payload.old as Assessment).id });
            return;
          }
          dispatch({ type: "UPSERT_ASSESSMENT", a: payload.new as Assessment });
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_personas", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") { dispatch({ type: "SET_PERSONA", p: null }); return; }
          dispatch({ type: "SET_PERSONA", p: payload.new as Persona });
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_scopes", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") { dispatch({ type: "SET_SCOPE", s: null }); return; }
          dispatch({ type: "SET_SCOPE", s: payload.new as Scope });
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            setConnected(true);
            await channel.track({ handle: session.handle, ready: false });
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setConnected(false);
          }
        });

      const beat = async () => {
        await client.from("room_participants")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("room_id", room.id)
          .eq("session_token", session.sessionToken);
      };
      beat();
      heartbeatRef.current = window.setInterval(beat, 20000);
    })();

    return () => {
      cancelled = true;
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      const ch = channelRef.current;
      if (ch) { ch.unsubscribe(); channelRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, session?.handle, state.room?.id]);

  // ----- Onboarding

  const onJoin = useCallback(async (handleRaw: string) => {
    if (!client || !session || !state.room) return;
    const handle = handleRaw.replace(/^@/, "").trim();
    if (!isHandleValid(handle)) {
      setPendingHandleError(t("onboard.handle_invalid"));
      return;
    }
    const { error } = await client.from("room_participants").insert({
      room_id: state.room.id,
      session_token: session.sessionToken,
      handle,
      last_seen_at: new Date().toISOString(),
      ready: false,
    });
    if (error) {
      if (error.code === "23505") setPendingHandleError(t("onboard.handle_taken"));
      else setPendingHandleError(error.message);
      return;
    }
    const updated: SessionData = { ...session, handle };
    saveSession(state.room.slug, updated);
    setSession(updated);
    setPendingHandleError(null);
  }, [client, session, state.room, t]);

  // ----- Action handlers (replace the old command parser)

  const attemptAdvance = useCallback(async () => {
    if (!client || !state.room) return;
    await client.rpc("attempt_advance_phase", { p_room: state.room.id });
  }, [client, state.room]);

  const addIdea = useCallback(async (text: string) => {
    if (!client || !session || !state.room) return;
    const t0 = text.trim();
    if (!t0) return;
    if (t0.length > 280) { toast("error", t("cmd.error.idea_too_long")); return; }
    const { error } = await client.from("room_ideas").insert({
      room_id: state.room.id,
      session_token: session.sessionToken,
      handle: session.handle!,
      text: t0,
    });
    if (error) {
      if (/idea.+limit|23514/.test(error.message)) toast("error", t("cmd.error.idea_limit"));
      else toast("error", t("cmd.error.network", { message: error.message }));
    }
  }, [client, session, state.room, t, toast]);

  const removeIdea = useCallback(async (idea: Idea) => {
    if (!client) return;
    await client.from("room_ideas").delete().eq("id", idea.id);
  }, [client]);

  const toggleVote = useCallback(async (idea: Idea, phase: "pick_two" | "pick_winner") => {
    if (!client || !session || !state.room) return;
    const mine = state.votes.find(
      (v) => v.session_token === session.sessionToken && v.idea_id === idea.id && v.phase === phase
    );
    if (mine) {
      await client.from("room_votes")
        .delete()
        .eq("room_id", state.room.id)
        .eq("session_token", session.sessionToken)
        .eq("idea_id", idea.id)
        .eq("phase", phase);
    } else {
      const { error } = await client.from("room_votes").insert({
        room_id: state.room.id,
        session_token: session.sessionToken,
        idea_id: idea.id,
        phase,
      });
      if (error) {
        if (/vote.+limit|23514/.test(error.message)) toast("error", t("cmd.error.vote_limit"));
        else if (error.code !== "23505") toast("error", t("cmd.error.network", { message: error.message }));
      }
    }
  }, [client, session, state.room, state.votes, t, toast]);

  const setAssessment = useCallback(async (idea: Idea, kind: AssessmentKind, verdict: Verdict, note?: string | null) => {
    if (!client || !session || !state.room) return;
    await client.from("room_assessments")
      .delete()
      .eq("room_id", state.room.id)
      .eq("idea_id", idea.id)
      .eq("kind", kind)
      .eq("session_token", session.sessionToken);
    const { error } = await client.from("room_assessments").insert({
      room_id: state.room.id,
      idea_id: idea.id,
      kind,
      session_token: session.sessionToken,
      verdict,
      note: note?.trim() || null,
    });
    if (error) toast("error", t("cmd.error.network", { message: error.message }));
  }, [client, session, state.room, t, toast]);

  const setPersonaField = useCallback(async (field: "who" | "context" | "pain", value: string) => {
    if (!client || !state.room) return;
    const base = state.persona ?? {
      room_id: state.room.id,
      idea_id: state.room.winner_idea_id,
      who: null,
      context: null,
      pain: null,
      updated_at: new Date().toISOString(),
    };
    await client.from("room_personas").upsert(
      { ...base, [field]: value.trim().slice(0, 280) || null, room_id: state.room.id, updated_at: new Date().toISOString() },
      { onConflict: "room_id" }
    );
  }, [client, state.room, state.persona]);

  const addScopeItem = useCallback(async (bucket: "must_have" | "nice_to_have" | "out_of_scope", value: string) => {
    if (!client || !state.room) return;
    const v = value.trim().slice(0, 280);
    if (!v) return;
    const base = state.scope ?? {
      room_id: state.room.id,
      must_have: [],
      nice_to_have: [],
      out_of_scope: [],
      updated_at: new Date().toISOString(),
    };
    await client.from("room_scopes").upsert(
      { ...base, [bucket]: base[bucket].concat(v), room_id: state.room.id, updated_at: new Date().toISOString() },
      { onConflict: "room_id" }
    );
  }, [client, state.room, state.scope]);

  const removeScopeItem = useCallback(async (bucket: "must_have" | "nice_to_have" | "out_of_scope", index: number) => {
    if (!client || !state.room || !state.scope) return;
    const current = state.scope[bucket];
    if (index < 0 || index >= current.length) return;
    const updated = current.slice(0, index).concat(current.slice(index + 1));
    await client.from("room_scopes").upsert(
      { ...state.scope, [bucket]: updated, room_id: state.room.id, updated_at: new Date().toISOString() },
      { onConflict: "room_id" }
    );
  }, [client, state.room, state.scope]);

  const toggleReady = useCallback(async () => {
    if (!client || !session || !state.room) return;
    const me = state.participants.get(session.sessionToken);
    const next = !(me?.ready ?? false);
    await client.from("room_participants")
      .update({ ready: next, last_seen_at: new Date().toISOString() })
      .eq("room_id", state.room.id)
      .eq("session_token", session.sessionToken);
    if (next) await attemptAdvance();
  }, [client, session, state.room, state.participants, attemptAdvance]);

  const leaveRoom = useCallback(async () => {
    if (!client || !session || !state.room) return;
    await client.from("room_participants")
      .delete()
      .eq("room_id", state.room.id)
      .eq("session_token", session.sessionToken);
    clearSession(state.room.slug);
    window.location.href = "/";
  }, [client, session, state.room]);

  const closeRoom = useCallback(async () => {
    if (!client || !session || !state.room) return;
    if (!session.hostToken) { toast("error", t("cmd.error.close_not_host")); return; }
    const { data, error } = await client.rpc("close_room", { p_room: state.room.id });
    if (error) { toast("error", t("cmd.error.network", { message: error.message })); return; }
    if (data !== true) toast("error", t("cmd.error.close_not_host"));
  }, [client, session, state.room, t, toast]);

  const copyBriefMarkdown = useCallback(() => {
    const md = buildBriefMarkdown(state);
    navigator.clipboard.writeText(md)
      .then(() => toast("success", t("cmd.success.copied")))
      .catch(() => {});
  }, [state, t, toast]);

  // ----- Render

  if (phaseStatus === "loading") {
    return <div className="room-shell"><div className="room-muted">{t("loading")}</div></div>;
  }
  if (phaseStatus === "no_env") {
    return (
      <div className="room-shell">
        <div className="room-error">{t("missing_env")}</div>
        <a className="room-back" href="/">{t("back_to_main")}</a>
      </div>
    );
  }
  if (phaseStatus === "not_found") {
    return (
      <div className="room-shell">
        <div className="room-error">{t("not_found")}</div>
        <a className="room-back" href="/">{t("back_to_main")}</a>
      </div>
    );
  }
  if (phaseStatus === "expired") {
    return (
      <div className="room-shell">
        <div className="room-error">{t("expired")}</div>
        <a className="room-back" href="/">{t("back_to_main")}</a>
      </div>
    );
  }

  if (!session?.handle) {
    return (
      <OnboardView
        slug={slug ?? ""}
        t={t}
        state={state}
        pendingHandle={pendingHandle}
        setPendingHandle={setPendingHandle}
        pendingHandleError={pendingHandleError}
        onJoin={onJoin}
      />
    );
  }

  const phase = state.room?.phase ?? "brainstorm";
  const me = state.participants.get(session.sessionToken);
  const isHost = !!session.hostToken;

  return (
    <div className="room-shell room-active">
      <RoomHeader
        slug={state.room?.slug ?? ""}
        phase={phase}
        connected={connected}
        ready={me?.ready ?? false}
        readyCount={readyAliveCount(state)}
        totalCount={aliveCount(state)}
        expiresAt={state.room?.expires_at ?? null}
        isHost={isHost}
        t={t}
        onToggleReady={toggleReady}
        onLeave={leaveRoom}
        onClose={closeRoom}
      />
      <ParticipantsStrip state={state} sessionToken={session.sessionToken} />
      <Toasts stream={state.stream} />

      {phase === "brainstorm" && (
        <BrainstormView
          state={state}
          sessionToken={session.sessionToken}
          t={t}
          onAdd={addIdea}
          onRemove={removeIdea}
        />
      )}
      {(phase === "pick_two" || phase === "pick_winner") && (
        <PickView
          state={state}
          phase={phase}
          sessionToken={session.sessionToken}
          t={t}
          onToggleVote={toggleVote}
        />
      )}
      {phase === "assess" && (
        <AssessView
          state={state}
          sessionToken={session.sessionToken}
          t={t}
          onSetAssessment={setAssessment}
        />
      )}
      {phase === "persona" && (
        <PersonaView state={state} t={t} onSet={setPersonaField} />
      )}
      {phase === "scope" && (
        <ScopeView state={state} t={t} onAdd={addScopeItem} onRemove={removeScopeItem} />
      )}
      {phase === "done" && (
        <DoneView state={state} t={t} onCopy={copyBriefMarkdown} onLeave={leaveRoom} />
      )}
    </div>
  );
}

// ---------- Subviews ----------

function OnboardView({
  slug, t, state, pendingHandle, setPendingHandle, pendingHandleError, onJoin,
}: {
  slug: string;
  t: ReturnType<typeof makeT>;
  state: RoomState;
  pendingHandle: string;
  setPendingHandle: (v: string) => void;
  pendingHandleError: string | null;
  onJoin: (h: string) => void | Promise<void>;
}) {
  const shareUrl = typeof window !== "undefined" ? window.location.href : "";
  const others = Array.from(state.participants.values());
  return (
    <div className="room-shell room-onboarding">
      <div className="room-banner">
        <pre className="room-banner-art">{`╔══════════════════════════════════════════════════════╗
║                                                      ║
║  ROOM ${slug.padEnd(46, " ")} ║
║  ${t("subtitle").padEnd(52, " ")}║
║                                                      ║
╚══════════════════════════════════════════════════════╝`}</pre>
      </div>
      <div className="room-onboard">
        <div className="room-line room-onboard-heading">{t("onboard.heading")}</div>
        {others.length > 0 && (
          <div className="room-line room-muted">
            {others.map((p) => "@" + p.handle).join(", ")}
          </div>
        )}
        <form className="room-onboard-form" onSubmit={(e) => { e.preventDefault(); onJoin(pendingHandle); }}>
          <span className="room-prompt-tag">{t("onboard.handle_prompt")}</span>
          <input
            autoFocus
            type="text"
            maxLength={32}
            placeholder="aiponce"
            value={pendingHandle}
            onChange={(e) => setPendingHandle(e.target.value)}
            className="room-input room-onboard-input"
          />
          <button type="submit" className="room-btn room-btn-primary">[ {t("onboard.cta")} ]</button>
        </form>
        {pendingHandleError && <div className="room-line room-error">{pendingHandleError}</div>}
        <div className="room-line room-muted room-onboard-share">{t("onboard.share", { url: shareUrl })}</div>
      </div>
      <a className="room-back" href="/">{t("back_to_main")}</a>
    </div>
  );
}

function RoomHeader({
  slug, phase, connected, ready, readyCount, totalCount, expiresAt, isHost,
  t, onToggleReady, onLeave, onClose,
}: {
  slug: string;
  phase: Phase;
  connected: boolean;
  ready: boolean;
  readyCount: number;
  totalCount: number;
  expiresAt: string | null;
  isHost: boolean;
  t: ReturnType<typeof makeT>;
  onToggleReady: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const mins = expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000)) : 0;
  return (
    <header className="room-header2">
      <div className="room-header-left">
        <div className="room-title-row">
          <span className="room-title">room / {slug}</span>
          <span className={connected ? "room-live" : "room-reconnecting"}>
            {connected ? t("status.live") : t("status.reconnecting")}
          </span>
        </div>
        <div className="room-meta-row">
          <span className="room-phase-pill">{t("status.phase", { phase: t("phase." + phase) })}</span>
          <span className="room-muted">·</span>
          <span className="room-muted">{t("status.quorum", { ready: readyCount, total: totalCount })}</span>
          {expiresAt && (
            <>
              <span className="room-muted">·</span>
              <span className="room-muted">{t("status.expires_in", { mins })}</span>
            </>
          )}
        </div>
      </div>
      <div className="room-header-right">
        {phase !== "done" && (
          <button
            type="button"
            className={`room-btn room-btn-ready ${ready ? "is-ready" : ""}`}
            onClick={onToggleReady}
          >
            [ {ready ? "✓ ready" : "ready"} ]
          </button>
        )}
        {isHost && phase !== "done" && (
          <button type="button" className="room-btn" onClick={onClose} title={t("help.line.close")}>
            [ close ]
          </button>
        )}
        <button type="button" className="room-btn room-btn-quiet" onClick={onLeave}>
          [ leave ]
        </button>
      </div>
    </header>
  );
}

function ParticipantsStrip({ state, sessionToken }: { state: RoomState; sessionToken: string }) {
  const ps = Array.from(state.participants.values()).sort((a, b) => a.handle.localeCompare(b.handle));
  return (
    <div className="room-participants">
      {ps.map((p) => {
        const alive = new Date(p.last_seen_at).getTime() > Date.now() - 60_000;
        const isMe = p.session_token === sessionToken;
        return (
          <span
            key={p.session_token}
            className={`room-chip ${alive ? "" : "is-stale"} ${p.ready ? "is-ready" : ""} ${isMe ? "is-me" : ""}`}
            title={isMe ? "you" : ""}
          >
            {p.ready ? "✓ " : ""}@{p.handle}{isMe ? " *" : ""}
          </span>
        );
      })}
    </div>
  );
}

function Toasts({ stream }: { stream: StreamLine[] }) {
  const visible = stream.filter((s) => s.text);
  if (visible.length === 0) return null;
  return (
    <div className="room-toasts">
      {visible.slice(-3).map((s) => (
        <div key={s.id} className={`room-toast room-line-${s.kind}`}>{s.text}</div>
      ))}
    </div>
  );
}

function BrainstormView({
  state, sessionToken, t, onAdd, onRemove,
}: {
  state: RoomState;
  sessionToken: string;
  t: ReturnType<typeof makeT>;
  onAdd: (text: string) => void | Promise<void>;
  onRemove: (idea: Idea) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sorted = Array.from(state.ideas.values()).sort(
    (a, b) => a.created_at.localeCompare(b.created_at)
  );

  useEffect(() => {
    // Auto-scroll on new ideas.
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sorted.length]);

  return (
    <div className="phase-pane">
      <div className="phase-instructions">
        <strong>{t("phase.brainstorm")}</strong> — {t("help.line.idea").trim().replace(/^idea\s+/, "")}
      </div>
      <div className="msg-list" ref={listRef}>
        {sorted.length === 0 && <div className="room-muted msg-empty">{t("panel.no_ideas")}</div>}
        {sorted.map((i) => {
          const mine = i.session_token === sessionToken;
          return (
            <div key={i.id} className={`msg ${mine ? "msg-mine" : ""}`}>
              <div className="msg-meta">
                <span className="msg-handle">@{i.handle}</span>
                <span className="room-muted msg-time">· {relTime(i.created_at)}</span>
                <span className="room-muted msg-id">· #{shortId(i.id)}</span>
                {mine && (
                  <button type="button" className="room-btn room-btn-tiny msg-remove" onClick={() => onRemove(i)} title="remove">
                    [×]
                  </button>
                )}
              </div>
              <div className="msg-body">{i.text}</div>
            </div>
          );
        })}
      </div>
      <form
        className="composer"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onAdd(draft); setDraft(""); inputRef.current?.focus(); } }}
      >
        <input
          ref={inputRef}
          type="text"
          maxLength={280}
          placeholder={t("composer.idea_placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="room-input composer-input"
          autoFocus
        />
        <button type="submit" className="room-btn room-btn-primary" disabled={!draft.trim()}>
          [ {t("composer.add")} ]
        </button>
      </form>
    </div>
  );
}

function PickView({
  state, phase, sessionToken, t, onToggleVote,
}: {
  state: RoomState;
  phase: "pick_two" | "pick_winner";
  sessionToken: string;
  t: ReturnType<typeof makeT>;
  onToggleVote: (i: Idea, p: "pick_two" | "pick_winner") => void | Promise<void>;
}) {
  // pick_winner shows only picked ideas; pick_two shows all.
  const candidates = Array.from(state.ideas.values())
    .filter((i) => phase === "pick_two" ? true : state.room?.picked_idea_ids?.includes(i.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const votesByIdea = new Map<string, number>();
  const myVotes = new Set<string>();
  for (const v of state.votes) {
    if (v.phase !== phase) continue;
    votesByIdea.set(v.idea_id, (votesByIdea.get(v.idea_id) ?? 0) + 1);
    if (v.session_token === sessionToken) myVotes.add(v.idea_id);
  }
  const myVoteCount = myVotes.size;
  const cap = phase === "pick_two" ? 2 : 1;

  return (
    <div className="phase-pane">
      <div className="phase-instructions">
        <strong>{t("phase." + phase)}</strong> —{" "}
        {phase === "pick_two" ? t("composer.pick_two_help") : t("composer.pick_winner_help")}{" "}
        ({myVoteCount}/{cap})
      </div>
      <div className="msg-list">
        {candidates.length === 0 && <div className="room-muted msg-empty">{t("panel.no_ideas")}</div>}
        {candidates.map((i) => {
          const c = votesByIdea.get(i.id) ?? 0;
          const voted = myVotes.has(i.id);
          const canVote = voted || myVoteCount < cap;
          return (
            <div key={i.id} className={`msg ${voted ? "msg-voted" : ""}`}>
              <div className="msg-meta">
                <span className="msg-handle">@{i.handle}</span>
                <span className="room-muted msg-time">· {relTime(i.created_at)}</span>
                <span className="room-muted msg-id">· #{shortId(i.id)}</span>
                <span className="msg-actions">
                  <button
                    type="button"
                    className={`room-btn room-btn-tiny ${voted ? "is-active" : ""}`}
                    disabled={!canVote}
                    onClick={() => onToggleVote(i, phase)}
                  >
                    [ {voted ? "★ voted" : "vote"} ]
                  </button>
                  <span className="room-muted msg-votes">{c} {c === 1 ? "vote" : "votes"}</span>
                </span>
              </div>
              <div className="msg-body">{i.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssessView({
  state, sessionToken, t, onSetAssessment,
}: {
  state: RoomState;
  sessionToken: string;
  t: ReturnType<typeof makeT>;
  onSetAssessment: (i: Idea, k: AssessmentKind, v: Verdict, note?: string | null) => void | Promise<void>;
}) {
  const picked = (state.room?.picked_idea_ids ?? [])
    .map((id) => state.ideas.get(id))
    .filter((x): x is Idea => !!x);

  return (
    <div className="phase-pane">
      <div className="phase-instructions">
        <strong>{t("phase.assess")}</strong> — {t("composer.assess_help")}
      </div>
      <div className="msg-list">
        {picked.map((idea) => (
          <AssessCard
            key={idea.id}
            idea={idea}
            state={state}
            sessionToken={sessionToken}
            t={t}
            onSetAssessment={onSetAssessment}
          />
        ))}
      </div>
    </div>
  );
}

function AssessCard({
  idea, state, sessionToken, t, onSetAssessment,
}: {
  idea: Idea;
  state: RoomState;
  sessionToken: string;
  t: ReturnType<typeof makeT>;
  onSetAssessment: (i: Idea, k: AssessmentKind, v: Verdict, note?: string | null) => void | Promise<void>;
}) {
  return (
    <div className="msg msg-picked">
      <div className="msg-meta">
        <span className="msg-handle">@{idea.handle}</span>
        <span className="room-muted msg-id">· #{shortId(idea.id)}</span>
        <span className="msg-actions">
          <span className="msg-pill">★ {t("composer.assess_picked_tag")}</span>
        </span>
      </div>
      <div className="msg-body msg-body-large">{idea.text}</div>
      <AssessRow
        idea={idea}
        kind="feasibility"
        label={t("brief.assess_feasibility")}
        state={state}
        sessionToken={sessionToken}
        onSetAssessment={onSetAssessment}
      />
      <AssessRow
        idea={idea}
        kind="state_of_the_art"
        label={t("brief.assess_sota")}
        state={state}
        sessionToken={sessionToken}
        onSetAssessment={onSetAssessment}
      />
    </div>
  );
}

function AssessRow({
  idea, kind, label, state, sessionToken, onSetAssessment,
}: {
  idea: Idea;
  kind: AssessmentKind;
  label: string;
  state: RoomState;
  sessionToken: string;
  onSetAssessment: (i: Idea, k: AssessmentKind, v: Verdict, note?: string | null) => void | Promise<void>;
}) {
  const mine = Array.from(state.assessments.values()).find(
    (a) => a.idea_id === idea.id && a.kind === kind && a.session_token === sessionToken
  );
  const tally = { yes: 0, no: 0, maybe: 0 };
  const notes: string[] = [];
  for (const a of state.assessments.values()) {
    if (a.idea_id === idea.id && a.kind === kind) {
      tally[a.verdict] += 1;
      if (a.note) notes.push(`"${a.note}"`);
    }
  }
  const [noteDraft, setNoteDraft] = useState(mine?.note ?? "");
  useEffect(() => { setNoteDraft(mine?.note ?? ""); }, [mine?.id, mine?.note]);

  const choose = (v: Verdict) => onSetAssessment(idea, kind, v, noteDraft || null);
  const saveNote = () => {
    if (mine) onSetAssessment(idea, kind, mine.verdict, noteDraft || null);
  };

  return (
    <div className="assess-row">
      <div className="assess-row-label">{label}</div>
      <div className="assess-row-actions">
        {(["yes", "maybe", "no"] as Verdict[]).map((v) => (
          <button
            key={v}
            type="button"
            className={`room-btn room-btn-tiny ${mine?.verdict === v ? "is-active" : ""}`}
            onClick={() => choose(v)}
          >
            [ {v} ]
          </button>
        ))}
        <input
          type="text"
          maxLength={280}
          placeholder="note (optional)"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveNote(); } }}
          className="room-input assess-note"
        />
      </div>
      <div className="assess-row-tally room-muted">
        {tally.yes} yes / {tally.maybe} maybe / {tally.no} no
        {notes.length > 0 && <span className="assess-notes"> — {notes.join(", ")}</span>}
      </div>
    </div>
  );
}

function PersonaView({
  state, t, onSet,
}: {
  state: RoomState;
  t: ReturnType<typeof makeT>;
  onSet: (f: "who" | "context" | "pain", v: string) => void | Promise<void>;
}) {
  const winner = state.room?.winner_idea_id ? state.ideas.get(state.room.winner_idea_id) : null;
  return (
    <div className="phase-pane">
      <div className="phase-instructions">
        <strong>{t("phase.persona")}</strong> — {t("composer.persona_help")}
      </div>
      {winner && (
        <div className="winner-banner">
          <span className="msg-pill">🏆 {t("brief.winner_label").replace(/^[^A-Z]+/, "")}</span>
          <span className="winner-text">{winner.text}</span>
        </div>
      )}
      <PersonaField label={t("brief.persona_who")} value={state.persona?.who ?? ""} onSave={(v) => onSet("who", v)} />
      <PersonaField label={t("brief.persona_context")} value={state.persona?.context ?? ""} onSave={(v) => onSet("context", v)} />
      <PersonaField label={t("brief.persona_pain")} value={state.persona?.pain ?? ""} onSave={(v) => onSet("pain", v)} />
    </div>
  );
}

function PersonaField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void | Promise<void> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const dirty = draft !== value;
  const submit = () => { if (dirty) onSave(draft); };
  return (
    <div className="persona-field">
      <label className="persona-label">{label}</label>
      <div className="persona-row">
        <input
          type="text"
          maxLength={280}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          className="room-input persona-input"
        />
        <button type="button" className="room-btn room-btn-tiny" disabled={!dirty} onClick={submit}>[ save ]</button>
      </div>
    </div>
  );
}

function ScopeView({
  state, t, onAdd, onRemove,
}: {
  state: RoomState;
  t: ReturnType<typeof makeT>;
  onAdd: (b: "must_have" | "nice_to_have" | "out_of_scope", v: string) => void | Promise<void>;
  onRemove: (b: "must_have" | "nice_to_have" | "out_of_scope", i: number) => void | Promise<void>;
}) {
  return (
    <div className="phase-pane">
      <div className="phase-instructions">
        <strong>{t("phase.scope")}</strong> — {t("composer.scope_help")}
      </div>
      <div className="scope-grid">
        <ScopeBucket label={t("brief.scope_must")} items={state.scope?.must_have ?? []} onAdd={(v) => onAdd("must_have", v)} onRemove={(i) => onRemove("must_have", i)} />
        <ScopeBucket label={t("brief.scope_nice")} items={state.scope?.nice_to_have ?? []} onAdd={(v) => onAdd("nice_to_have", v)} onRemove={(i) => onRemove("nice_to_have", i)} />
        <ScopeBucket label={t("brief.scope_out")} items={state.scope?.out_of_scope ?? []} onAdd={(v) => onAdd("out_of_scope", v)} onRemove={(i) => onRemove("out_of_scope", i)} />
      </div>
    </div>
  );
}

function ScopeBucket({
  label, items, onAdd, onRemove,
}: {
  label: string;
  items: string[];
  onAdd: (v: string) => void | Promise<void>;
  onRemove: (i: number) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="scope-bucket">
      <div className="scope-bucket-h">{label}</div>
      <ul className="scope-list">
        {items.map((it, i) => (
          <li key={`${i}-${it}`} className="scope-item">
            <span>{it}</span>
            <button type="button" className="room-btn room-btn-tiny" onClick={() => onRemove(i)} aria-label="remove">[ × ]</button>
          </li>
        ))}
        {items.length === 0 && <li className="room-muted scope-item-empty">no items yet</li>}
      </ul>
      <form
        className="scope-add"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onAdd(draft); setDraft(""); } }}
      >
        <input
          type="text"
          maxLength={280}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add…"
          className="room-input scope-input"
        />
        <button type="submit" className="room-btn room-btn-tiny scope-add-btn" disabled={!draft.trim()}>[ add ]</button>
      </form>
    </div>
  );
}

function DoneView({
  state, t, onCopy, onLeave,
}: {
  state: RoomState;
  t: ReturnType<typeof makeT>;
  onCopy: () => void;
  onLeave: () => void;
}) {
  const { ideas, votes, assessments, room, persona, scope } = state;
  const winner = room?.winner_idea_id ? ideas.get(room.winner_idea_id) : null;
  const sortedIdeas = Array.from(ideas.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const voteCounts = new Map<string, number>();
  for (const v of votes) {
    if (v.phase === "pick_two") voteCounts.set(v.idea_id, (voteCounts.get(v.idea_id) ?? 0) + 1);
  }
  const pickedSummaries = (room?.picked_idea_ids ?? []).map((id) => {
    const idea = ideas.get(id);
    const buckets = {
      feasibility: { yes: 0, no: 0, maybe: 0, notes: [] as string[] },
      state_of_the_art: { yes: 0, no: 0, maybe: 0, notes: [] as string[] },
    };
    for (const a of assessments.values()) {
      if (a.idea_id !== id) continue;
      const b = buckets[a.kind];
      b[a.verdict] += 1;
      if (a.note) b.notes.push(a.note);
    }
    return { idea, buckets };
  });

  return (
    <div className="phase-pane room-brief">
      <div className="brief-line brief-rule">{t("brief.heading")}</div>
      {winner && (
        <>
          <div className="brief-line brief-section">{t("brief.winner_label")}</div>
          <div className="brief-line brief-winner">┌─────────────────────────────────────────┐</div>
          <div className="brief-line brief-winner">│  {winner.text}</div>
          <div className="brief-line brief-winner">└─────────────────────────────────────────┘</div>
          <div className="brief-line">&nbsp;</div>
        </>
      )}
      <div className="brief-line brief-section">{t("brief.ideas_label", { count: sortedIdeas.length })}</div>
      {sortedIdeas.map((i) => {
        const c = voteCounts.get(i.id) ?? 0;
        const marker = winner?.id === i.id ? "🏆" : c > 0 ? "✅" : "⚪";
        return (
          <div key={i.id} className="brief-line">
            {"    "}{marker} {i.text}  <span className="room-muted">({c} votes · @{i.handle})</span>
          </div>
        );
      })}
      <div className="brief-line">&nbsp;</div>

      {pickedSummaries.length > 0 && (
        <>
          <div className="brief-line brief-section">{t("brief.assess_label")}</div>
          {pickedSummaries.map(({ idea, buckets }) => idea && (
            <div key={idea.id}>
              <div className="brief-line">{"    "}#{shortId(idea.id)} — {idea.text}</div>
              <div className="brief-line">{"      "}{t("brief.assess_feasibility")}: {buckets.feasibility.yes} yes / {buckets.feasibility.maybe} maybe / {buckets.feasibility.no} no</div>
              {buckets.feasibility.notes.length > 0 && (
                <div className="brief-line room-muted">{"        notes: "}{buckets.feasibility.notes.map((n) => `"${n}"`).join(", ")}</div>
              )}
              <div className="brief-line">{"      "}{t("brief.assess_sota")}: {buckets.state_of_the_art.yes} yes / {buckets.state_of_the_art.maybe} maybe / {buckets.state_of_the_art.no} no</div>
              {buckets.state_of_the_art.notes.length > 0 && (
                <div className="brief-line room-muted">{"        notes: "}{buckets.state_of_the_art.notes.map((n) => `"${n}"`).join(", ")}</div>
              )}
            </div>
          ))}
          <div className="brief-line">&nbsp;</div>
        </>
      )}

      {persona && (persona.who || persona.context || persona.pain) && (
        <>
          <div className="brief-line brief-section">{t("brief.persona_label")}</div>
          {persona.who && <div className="brief-line">{"    "}{t("brief.persona_who")}:     {persona.who}</div>}
          {persona.context && <div className="brief-line">{"    "}{t("brief.persona_context")}: {persona.context}</div>}
          {persona.pain && <div className="brief-line">{"    "}{t("brief.persona_pain")}:    {persona.pain}</div>}
          <div className="brief-line">&nbsp;</div>
        </>
      )}

      {scope && (scope.must_have.length || scope.nice_to_have.length || scope.out_of_scope.length) ? (
        <>
          <div className="brief-line brief-section">{t("brief.scope_label")}</div>
          {scope.must_have.length > 0 && (
            <>
              <div className="brief-line brief-sub">{"    "}{t("brief.scope_must")}</div>
              {scope.must_have.map((s, i) => <div key={i} className="brief-line">{"      • "}{s}</div>)}
            </>
          )}
          {scope.nice_to_have.length > 0 && (
            <>
              <div className="brief-line brief-sub">{"    "}{t("brief.scope_nice")}</div>
              {scope.nice_to_have.map((s, i) => <div key={i} className="brief-line">{"      • "}{s}</div>)}
            </>
          )}
          {scope.out_of_scope.length > 0 && (
            <>
              <div className="brief-line brief-sub">{"    "}{t("brief.scope_out")}</div>
              {scope.out_of_scope.map((s, i) => <div key={i} className="brief-line">{"      • "}{s}</div>)}
            </>
          )}
          <div className="brief-line">&nbsp;</div>
        </>
      ) : null}

      <div className="brief-line brief-rule">{t("brief.footer")}</div>
      <div className="brief-actions">
        <button type="button" className="room-btn room-btn-primary" onClick={onCopy}>
          [ {t("composer.copy_markdown")} ]
        </button>
        <button type="button" className="room-btn" onClick={onLeave}>
          [ {t("composer.close_room")} ]
        </button>
      </div>
    </div>
  );
}
