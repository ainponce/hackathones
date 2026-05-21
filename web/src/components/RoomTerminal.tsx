// RoomTerminal — collaborative brainstorm room rendered as a sub-terminal.
//
// Mounted by /room/index.astro as a client-only React island. Reads the room
// slug from window.location.pathname (`/room/<slug>`, served via vercel.json
// rewrite to keep the URL pretty without an SSR adapter).
//
// State flow:
//   1. On mount, read session from localStorage and load the room row.
//   2. If no handle yet, render the onboarding step (handle input).
//   3. Once joined, subscribe to postgres_changes + presence on
//      `room:<slug>`. Rehydrate every table on subscribe. Heartbeat every
//      20s. Run `attempt_advance_phase` whenever this client toggles ready.
//   4. The terminal stream is in-memory: lines append as events flow through
//      realtime. Reduced from postgres_changes payloads via the deriveLine
//      mapper.

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

// ---------- Slug extraction ----------

function extractSlug(): string | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.replace(/\/+$/, "");
  // Supported URL shapes:
  //   /room/<slug>            (canonical, via vercel.json rewrite)
  //   /room?id=<slug>         (fallback when rewrite is unavailable)
  const m = path.match(/^\/room\/([a-z0-9-]+)$/i);
  if (m) return m[1].toLowerCase();
  try {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) return id.toLowerCase();
  } catch {}
  return null;
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
  | { type: "APPEND_LINE"; line: StreamLine }
  | { type: "CLEAR_STREAM" };

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
      // Idempotent on (session_token, idea_id, phase).
      const filtered = state.votes.filter(
        (v) =>
          !(
            v.session_token === action.vote.session_token &&
            v.idea_id === action.vote.idea_id &&
            v.phase === action.vote.phase
          )
      );
      return { ...state, votes: [...filtered, action.vote] };
    }
    case "REMOVE_VOTE": {
      return {
        ...state,
        votes: state.votes.filter(
          (v) =>
            !(
              v.session_token === action.v.session_token &&
              v.idea_id === action.v.idea_id &&
              v.phase === action.v.phase
            )
        ),
      };
    }
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
    case "APPEND_LINE":
      return { ...state, stream: state.stream.concat(action.line).slice(-500) };
    case "CLEAR_STREAM":
      return { ...state, stream: [] };
  }
}

// ---------- Helpers ----------

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6);
}

function findIdeaByShort(state: RoomState, short: string): Idea | null {
  const target = short.replace(/^#/, "").toLowerCase();
  for (const i of state.ideas.values()) {
    if (i.id.replace(/-/g, "").toLowerCase().startsWith(target)) return i;
  }
  return null;
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
  try {
    localStorage.setItem(ROOM_SESSION_KEY(slug), JSON.stringify(data));
  } catch {}
}

function clearSession(slug: string): void {
  try {
    localStorage.removeItem(ROOM_SESSION_KEY(slug));
  } catch {}
}

function isHandleValid(h: string): boolean {
  return /^[a-zA-Z0-9_-]{2,32}$/.test(h.replace(/^@/, ""));
}

function newLine(
  kind: StreamLine["kind"],
  text: string
): StreamLine {
  return {
    id: Math.random().toString(36).slice(2),
    kind,
    text,
    ts: Date.now(),
  };
}

// Phase ordering for the human-readable "expected → next" indicators.
const PHASE_ORDER: Phase[] = [
  "brainstorm",
  "pick_two",
  "assess",
  "pick_winner",
  "persona",
  "scope",
  "done",
];

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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  // Realtime callbacks set up in a useEffect close over the state at effect
  // time, so without a ref they'd report stale data (e.g. "@undefined voted"
  // because participants was still empty when the channel subscribed). The
  // ref is updated every render and read inside the callbacks.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const [input, setInput] = useState("");
  const [pendingHandle, setPendingHandle] = useState("");
  const [pendingHandleError, setPendingHandleError] = useState<string | null>(null);

  const dict: RoomDict = useMemo(
    () => loadRoomDict((state.room?.locale as Locale) ?? "en"),
    [state.room?.locale]
  );
  const t = useMemo(() => makeT(dict), [dict]);

  const appendLine = useCallback((kind: StreamLine["kind"], text: string) => {
    dispatch({ type: "APPEND_LINE", line: newLine(kind, text) });
  }, []);

  // -------- 1. Mount: discover slug + session + bootstrap client + load room

  useEffect(() => {
    if (!slug) {
      setPhaseStatus("not_found");
      return;
    }
    if (!hasSupabaseEnv()) {
      setPhaseStatus("no_env");
      return;
    }
    let cancelled = false;

    (async () => {
      const existing = loadSession(slug);
      let sess = existing;
      if (!sess) {
        sess = { sessionToken: generateToken(), handle: null };
        saveSession(slug, sess);
      }
      const c = makeRoomClient({ sessionToken: sess.sessionToken, hostToken: sess.hostToken });
      const { data, error } = await c
        .from("rooms")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setPhaseStatus("not_found");
        return;
      }
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

    return () => {
      cancelled = true;
    };
  }, [slug]);

  // -------- 2. Join: when client + session exist and handle is set, subscribe.

  useEffect(() => {
    if (phaseStatus !== "ready" || !client || !session || !state.room || !session.handle) return;
    const room = state.room;
    let cancelled = false;

    (async () => {
      // Insert (or refresh) our participant row. We try to upsert by primary
      // key so reconnecting with the same session_token is idempotent.
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

      // Hydrate snapshot.
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
      appendLine("info", t("stream.welcome", { handle: "@" + session.handle! }));

      // Subscribe.
      const channel = client.channel(`room:${room.slug}`, {
        config: {
          presence: { key: session.sessionToken },
          broadcast: { self: false },
        },
      });

      channelRef.current = channel;

      const tableFilter = `room_id=eq.${room.id}`;

      channel
        .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.id}` }, (payload) => {
          if (payload.eventType === "DELETE") {
            setPhaseStatus("expired");
            return;
          }
          const newRoom = payload.new as Room;
          const prev = stateRef.current.room;
          dispatch({ type: "SET_ROOM", room: newRoom });
          if (prev && prev.phase !== newRoom.phase) {
            if (prev.phase === "assess" && newRoom.phase === "brainstorm") {
              appendLine("muted", t("stream.phase_back_to_brainstorm"));
            }
            appendLine("success", t("stream.phase_advanced", { phase: t("phase." + newRoom.phase) }));
          }
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_participants", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as Participant;
            dispatch({ type: "REMOVE_PARTICIPANT", sessionToken: old.session_token });
            appendLine("muted", t("stream.left", { handle: "@" + old.handle }));
            return;
          }
          const p = payload.new as Participant;
          const before = stateRef.current.participants.get(p.session_token);
          dispatch({ type: "UPSERT_PARTICIPANT", p });
          if (!before && p.session_token !== session.sessionToken) {
            appendLine("info", t("stream.joined", { handle: "@" + p.handle }));
          }
          if (before && before.ready !== p.ready && p.session_token !== session.sessionToken) {
            appendLine("muted", t(p.ready ? "stream.ready_on" : "stream.ready_off", { handle: "@" + p.handle }));
          }
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_ideas", filter: tableFilter }, (payload) => {
          const i = payload.new as Idea;
          dispatch({ type: "UPSERT_IDEA", idea: i });
          if (i.session_token !== session.sessionToken) {
            appendLine("info", t("stream.idea_added", { handle: "@" + i.handle, text: i.text }));
          }
        })
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "room_ideas", filter: tableFilter }, (payload) => {
          const old = payload.old as Idea;
          dispatch({ type: "REMOVE_IDEA", id: old.id });
          if (old.session_token !== session.sessionToken) {
            appendLine("muted", t("stream.idea_removed", { handle: "@" + old.handle }));
          }
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_votes", filter: tableFilter }, (payload) => {
          const v = payload.new as Vote;
          dispatch({ type: "UPSERT_VOTE", vote: v });
          if (v.session_token !== session.sessionToken) {
            const idea = stateRef.current.ideas.get(v.idea_id);
            const voter = stateRef.current.participants.get(v.session_token);
            appendLine("muted", t("stream.vote_cast", {
              handle: "@" + (voter?.handle ?? "someone"),
              short: idea ? shortId(idea.id) : "?",
            }));
          }
        })
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "room_votes", filter: tableFilter }, (payload) => {
          const old = payload.old as Vote;
          dispatch({ type: "REMOVE_VOTE", v: old });
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_assessments", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") {
            dispatch({ type: "REMOVE_ASSESSMENT", id: (payload.old as Assessment).id });
            return;
          }
          const a = payload.new as Assessment;
          dispatch({ type: "UPSERT_ASSESSMENT", a });
          if (a.session_token !== session.sessionToken) {
            const idea = stateRef.current.ideas.get(a.idea_id);
            const voter = stateRef.current.participants.get(a.session_token);
            appendLine("muted", t("stream.assessment", {
              handle: "@" + (voter?.handle ?? "someone"),
              short: idea ? shortId(idea.id) : "?",
              kind: a.kind === "feasibility" ? t("brief.assess_feasibility") : t("brief.assess_sota"),
              verdict: a.verdict,
              note: a.note ? ` — "${a.note}"` : "",
            }));
          }
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_personas", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") {
            dispatch({ type: "SET_PERSONA", p: null });
            return;
          }
          dispatch({ type: "SET_PERSONA", p: payload.new as Persona });
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "room_scopes", filter: tableFilter }, (payload) => {
          if (payload.eventType === "DELETE") {
            dispatch({ type: "SET_SCOPE", s: null });
            return;
          }
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

      // Heartbeat: keep last_seen_at fresh so the quorum function counts us.
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
      if (ch) {
        ch.unsubscribe();
        channelRef.current = null;
      }
    };
    // We intentionally depend on session.handle (joining triggers this).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, session?.handle, state.room?.id]);

  // -------- 3. Onboarding submit

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
      if (error.code === "23505") {
        setPendingHandleError(t("onboard.handle_taken"));
      } else {
        setPendingHandleError(error.message);
      }
      return;
    }
    const updated: SessionData = { ...session, handle };
    saveSession(state.room.slug, updated);
    setSession(updated);
    setPendingHandleError(null);
  }, [client, session, state.room, t]);

  // -------- 4. Commands

  const attemptAdvance = useCallback(async () => {
    if (!client || !state.room) return;
    await client.rpc("attempt_advance_phase", { p_room: state.room.id });
  }, [client, state.room]);

  const runCommand = useCallback(async (raw: string) => {
    if (!client || !session || !state.room) return;
    const room = state.room;
    const phase = room.phase;
    const trimmed = raw.trim();
    if (!trimmed) return;
    appendLine("echo", `$ ${trimmed}`);

    const tokens = trimmed.split(/\s+/);
    const cmd = tokens[0].toLowerCase();
    const args = tokens.slice(1);

    const requirePhase = (allowed: Phase[]) => {
      if (!allowed.includes(phase)) {
        appendLine("error", t("cmd.error.wrong_phase", { phase: t("phase." + phase) }));
        return false;
      }
      return true;
    };

    try {
      switch (cmd) {
        case "help": {
          appendLine("info", t("help.header", { phase: t("phase." + phase) }));
          appendLine("muted", t("help.line.ready"));
          appendLine("muted", t("help.line.who"));
          appendLine("muted", t("help.line.phase"));
          appendLine("muted", t("help.line.help"));
          appendLine("muted", t("help.line.clear"));
          appendLine("muted", t("help.line.leave"));
          appendLine("muted", t("help.line.close"));
          if (phase === "brainstorm") {
            appendLine("muted", t("help.line.idea"));
            appendLine("muted", t("help.line.idea_rm"));
          }
          if (phase === "pick_two" || phase === "pick_winner") {
            appendLine("muted", t("help.line.vote"));
            appendLine("muted", t("help.line.unvote"));
          }
          if (phase === "assess") {
            appendLine("muted", t("help.line.assess"));
          }
          if (phase === "persona") {
            appendLine("muted", t("help.line.persona"));
          }
          if (phase === "scope") {
            appendLine("muted", t("help.line.scope_add"));
            appendLine("muted", t("help.line.scope_rm"));
          }
          return;
        }

        case "clear": {
          dispatch({ type: "CLEAR_STREAM" });
          return;
        }

        case "who": {
          const list = Array.from(state.participants.values())
            .sort((a, b) => a.handle.localeCompare(b.handle));
          for (const p of list) {
            const tag = p.session_token === session.sessionToken ? " (you)" : "";
            const r = p.ready ? "✓" : "·";
            appendLine("info", `  ${r} @${p.handle}${tag}`);
          }
          return;
        }

        case "phase": {
          const total = aliveCount(state);
          const ready = readyAliveCount(state);
          appendLine("info", t("status.phase", { phase: t("phase." + phase) }));
          appendLine("muted", t("status.quorum", { ready, total }));
          return;
        }

        case "ready":
        case "not-ready": {
          const nextReady = cmd === "ready";
          await client.from("room_participants")
            .update({ ready: nextReady, last_seen_at: new Date().toISOString() })
            .eq("room_id", room.id)
            .eq("session_token", session.sessionToken);
          if (nextReady) await attemptAdvance();
          return;
        }

        case "leave": {
          await client.from("room_participants")
            .delete()
            .eq("room_id", room.id)
            .eq("session_token", session.sessionToken);
          clearSession(room.slug);
          appendLine("success", t("cmd.success.left"));
          window.setTimeout(() => { window.location.href = "/"; }, 800);
          return;
        }

        case "close": {
          if (!session.hostToken) {
            appendLine("error", t("cmd.error.close_not_host"));
            return;
          }
          const { data, error } = await client.rpc("close_room", { p_room: room.id });
          if (error) {
            appendLine("error", t("cmd.error.network", { message: error.message }));
            return;
          }
          if (data !== true) {
            appendLine("error", t("cmd.error.close_not_host"));
          }
          return;
        }

        case "idea": {
          if (!requirePhase(["brainstorm"])) return;
          if (args[0] === "rm") {
            const id = args[1];
            if (!id) { appendLine("error", t("cmd.error.idea_required")); return; }
            const idea = findIdeaByShort(state, id);
            if (!idea) { appendLine("error", t("cmd.error.idea_not_found", { id })); return; }
            if (idea.session_token !== session.sessionToken) {
              appendLine("error", t("cmd.error.idea_not_yours"));
              return;
            }
            await client.from("room_ideas").delete().eq("id", idea.id);
            return;
          }
          const text = args.join(" ").trim();
          if (!text) { appendLine("error", t("cmd.error.idea_required")); return; }
          if (text.length > 280) { appendLine("error", t("cmd.error.idea_too_long")); return; }
          const { error } = await client.from("room_ideas").insert({
            room_id: room.id,
            session_token: session.sessionToken,
            handle: session.handle!,
            text,
          });
          if (error) {
            if (/idea_per_session_limit|idea_limit|23514/.test(error.message)) {
              appendLine("error", t("cmd.error.idea_limit"));
            } else {
              appendLine("error", t("cmd.error.network", { message: error.message }));
            }
          }
          return;
        }

        case "vote":
        case "unvote": {
          if (!requirePhase(["pick_two", "pick_winner"])) return;
          const id = args[0];
          if (!id) { appendLine("error", t("cmd.error.vote_required")); return; }
          const idea = findIdeaByShort(state, id);
          if (!idea) { appendLine("error", t("cmd.error.idea_not_found", { id })); return; }
          if (phase === "pick_winner" && !room.picked_idea_ids.includes(idea.id)) {
            appendLine("error", t("cmd.error.vote_invalid"));
            return;
          }
          if (cmd === "vote") {
            const { error } = await client.from("room_votes").insert({
              room_id: room.id,
              session_token: session.sessionToken,
              idea_id: idea.id,
              phase,
            });
            if (error) {
              if (/vote.+limit|23514/.test(error.message)) {
                appendLine("error", t("cmd.error.vote_limit"));
              } else if (error.code === "23505") {
                // already voted — silent no-op
              } else {
                appendLine("error", t("cmd.error.network", { message: error.message }));
              }
            }
          } else {
            const existing = state.votes.find(
              (v) => v.session_token === session.sessionToken && v.idea_id === idea.id && v.phase === phase
            );
            if (!existing) {
              appendLine("error", t("cmd.error.unvote_not_found", { id }));
              return;
            }
            await client.from("room_votes")
              .delete()
              .eq("room_id", room.id)
              .eq("session_token", session.sessionToken)
              .eq("idea_id", idea.id)
              .eq("phase", phase);
          }
          return;
        }

        case "assess": {
          if (!requirePhase(["assess"])) return;
          // Parse: assess <idea-id> <feasibility|sota> <yes|no|maybe> [--note "..."]
          if (args.length < 3) { appendLine("error", t("cmd.error.assess_usage")); return; }
          const idea = findIdeaByShort(state, args[0]);
          if (!idea) { appendLine("error", t("cmd.error.idea_not_found", { id: args[0] })); return; }
          if (!room.picked_idea_ids.includes(idea.id)) {
            appendLine("error", t("cmd.error.assess_idea_invalid"));
            return;
          }
          const kindArg = args[1].toLowerCase();
          let kind: AssessmentKind;
          if (kindArg === "feasibility" || kindArg === "f") kind = "feasibility";
          else if (kindArg === "sota" || kindArg === "state_of_the_art" || kindArg === "s") kind = "state_of_the_art";
          else { appendLine("error", t("cmd.error.assess_usage")); return; }
          const verdictArg = args[2].toLowerCase();
          if (verdictArg !== "yes" && verdictArg !== "no" && verdictArg !== "maybe") {
            appendLine("error", t("cmd.error.assess_usage"));
            return;
          }
          const verdict = verdictArg as Verdict;
          // Optional --note "..."
          let note: string | null = null;
          const noteIdx = args.indexOf("--note");
          if (noteIdx >= 0 && args.length > noteIdx + 1) {
            // Join the rest, strip surrounding quotes if present.
            const rest = args.slice(noteIdx + 1).join(" ");
            note = rest.replace(/^["']|["']$/g, "").slice(0, 280);
          }
          // Upsert: delete then insert (Supabase JS doesn't accept onConflict on unique 4-col combo easily).
          await client.from("room_assessments")
            .delete()
            .eq("room_id", room.id)
            .eq("idea_id", idea.id)
            .eq("kind", kind)
            .eq("session_token", session.sessionToken);
          const { error } = await client.from("room_assessments").insert({
            room_id: room.id,
            idea_id: idea.id,
            kind,
            session_token: session.sessionToken,
            verdict,
            note,
          });
          if (error) appendLine("error", t("cmd.error.network", { message: error.message }));
          return;
        }

        case "persona": {
          if (!requirePhase(["persona"])) return;
          if (args.length < 2) { appendLine("error", t("cmd.error.persona_usage")); return; }
          const field = args[0].toLowerCase();
          if (field !== "who" && field !== "context" && field !== "pain") {
            appendLine("error", t("cmd.error.persona_usage"));
            return;
          }
          const value = args.slice(1).join(" ").trim().slice(0, 280);
          if (!value) { appendLine("error", t("cmd.error.persona_usage")); return; }
          const next: Partial<Persona> = { [field]: value, updated_at: new Date().toISOString() };
          const base = state.persona ?? {
            room_id: room.id,
            idea_id: room.winner_idea_id,
            who: null,
            context: null,
            pain: null,
            updated_at: new Date().toISOString(),
          };
          await client.from("room_personas").upsert(
            { ...base, ...next, room_id: room.id },
            { onConflict: "room_id" }
          );
          appendLine("info", t("stream.persona_set", { handle: "@" + session.handle!, field, value }));
          return;
        }

        case "scope": {
          if (!requirePhase(["scope"])) return;
          if (args[0] === "rm") {
            const bucket = args[1]?.toLowerCase();
            const n = parseInt(args[2] ?? "", 10);
            if (!bucket || isNaN(n)) { appendLine("error", t("cmd.error.scope_usage")); return; }
            const col = bucketColumn(bucket);
            if (!col) { appendLine("error", t("cmd.error.scope_usage")); return; }
            const current = state.scope ? state.scope[col] : [];
            if (n < 1 || n > current.length) {
              appendLine("error", t("cmd.error.scope_index"));
              return;
            }
            const updated = current.slice(0, n - 1).concat(current.slice(n));
            const base = state.scope ?? {
              room_id: room.id,
              must_have: [],
              nice_to_have: [],
              out_of_scope: [],
              updated_at: new Date().toISOString(),
            };
            await client.from("room_scopes").upsert(
              { ...base, [col]: updated, room_id: room.id, updated_at: new Date().toISOString() },
              { onConflict: "room_id" }
            );
            appendLine("muted", t("stream.scope_removed", { handle: "@" + session.handle!, bucket, n }));
            return;
          }
          const bucket = args[0]?.toLowerCase();
          const col = bucketColumn(bucket ?? "");
          if (!col) { appendLine("error", t("cmd.error.scope_usage")); return; }
          const value = args.slice(1).join(" ").trim().slice(0, 280);
          if (!value) { appendLine("error", t("cmd.error.scope_usage")); return; }
          const current = state.scope ? state.scope[col] : [];
          const base = state.scope ?? {
            room_id: room.id,
            must_have: [],
            nice_to_have: [],
            out_of_scope: [],
            updated_at: new Date().toISOString(),
          };
          await client.from("room_scopes").upsert(
            { ...base, [col]: current.concat(value), room_id: room.id, updated_at: new Date().toISOString() },
            { onConflict: "room_id" }
          );
          appendLine("info", t("stream.scope_added", { handle: "@" + session.handle!, bucket: bucket ?? "", value }));
          return;
        }

        default:
          appendLine("error", t("cmd.error.unknown", { cmd }));
          appendLine("muted", t("cmd.error.hint"));
      }
    } catch (e: any) {
      appendLine("error", t("cmd.error.network", { message: e?.message ?? String(e) }));
    }
  }, [client, session, state, t, appendLine, attemptAdvance]);

  // -------- 5. Stream auto-scroll

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.stream.length]);

  // -------- 6. Keyboard handling on the brief screen

  useEffect(() => {
    if (state.room?.phase !== "done") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "c" || e.key === "C") {
        const md = buildBriefMarkdown(state);
        navigator.clipboard.writeText(md).then(() => {
          appendLine("success", t("cmd.success.copied"));
        }).catch(() => {});
      } else if (e.key === "Enter") {
        clearSession(state.room!.slug);
        window.location.href = "/";
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, t, appendLine]);

  // -------- 7. Render

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

  // Onboarding (no handle yet)
  if (!session?.handle) {
    const shareUrl = typeof window !== "undefined" ? window.location.href : "";
    return (
      <div className="room-shell">
        <div className="room-header">
          <span className="room-title">{t("title")} / {slug}</span>
          <span className="room-sub">{t("subtitle")}</span>
        </div>
        <div className="room-onboard">
          <div className="room-line">{t("onboard.heading")}</div>
          <div className="room-line room-muted">{t("onboard.share", { url: shareUrl })}</div>
          <form
            className="room-onboard-form"
            onSubmit={(e) => { e.preventDefault(); onJoin(pendingHandle); }}
          >
            <span className="room-prompt">{t("onboard.handle_prompt")}</span>
            <input
              autoFocus
              type="text"
              maxLength={32}
              value={pendingHandle}
              onChange={(e) => setPendingHandle(e.target.value)}
              className="room-input"
            />
            <button type="submit" className="room-btn">{t("onboard.cta")}</button>
          </form>
          {pendingHandleError && <div className="room-line room-error">{pendingHandleError}</div>}
        </div>
        <a className="room-back" href="/">{t("back_to_main")}</a>
      </div>
    );
  }

  // Main room view
  return (
    <div className="room-shell room-active">
      <div className="room-header">
        <span className="room-title">{t("title")} / {state.room?.slug}</span>
        <span className="room-sub">{t("subtitle")}</span>
        <span className="room-status">
          <span className={connected ? "room-live" : "room-reconnecting"}>
            {connected ? t("status.live") : t("status.reconnecting")}
          </span>
          {state.room?.expires_at && (
            <span className="room-muted">
              {" · "}{t("status.expires_in", { mins: Math.max(0, Math.round((new Date(state.room.expires_at).getTime() - Date.now()) / 60000)) })}
            </span>
          )}
        </span>
      </div>

      {state.room?.phase === "done" ? (
        <BriefView state={state} t={t} />
      ) : (
        <div className="room-body">
          <div className="room-main">
            <div className="room-stream" ref={streamRef}>
              {state.stream.map((line) => (
                <div key={line.id} className={`room-line room-line-${line.kind}`}>{line.text}</div>
              ))}
            </div>
            <form
              className="room-prompt-row"
              onSubmit={(e) => { e.preventDefault(); const v = input; setInput(""); runCommand(v); }}
            >
              <span className="room-prompt-tag">
                @{session.handle}@{state.room?.slug}:{t("phase." + (state.room?.phase ?? "brainstorm"))}$
              </span>
              <input
                ref={inputRef}
                type="text"
                autoFocus
                className="room-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </form>
          </div>
          <RoomSidebar state={state} t={t} session={session} />
        </div>
      )}
    </div>
  );
}

// ---------- Subcomponents ----------

function bucketColumn(bucket: string): "must_have" | "nice_to_have" | "out_of_scope" | null {
  if (bucket === "must") return "must_have";
  if (bucket === "nice") return "nice_to_have";
  if (bucket === "out") return "out_of_scope";
  return null;
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

function RoomSidebar({
  state,
  t,
  session,
}: {
  state: RoomState;
  t: ReturnType<typeof makeT>;
  session: SessionData;
}) {
  const phase = state.room?.phase ?? "brainstorm";
  const total = aliveCount(state);
  const ready = readyAliveCount(state);
  const voteCounts = new Map<string, number>();
  for (const v of state.votes) {
    if (v.phase === phase || (phase === "assess" && v.phase === "pick_two")) {
      voteCounts.set(v.idea_id, (voteCounts.get(v.idea_id) ?? 0) + 1);
    }
  }
  const sortedIdeas = Array.from(state.ideas.values()).sort(
    (a, b) => a.created_at.localeCompare(b.created_at)
  );

  return (
    <aside className="room-side">
      <div className="room-side-section">
        <div className="room-side-h">{t("status.phase", { phase: t("phase." + phase) })}</div>
        <div className="room-muted">{t("status.quorum", { ready, total })}</div>
      </div>
      <div className="room-side-section">
        <div className="room-side-h">{t("panel.roster")}</div>
        {Array.from(state.participants.values())
          .sort((a, b) => a.handle.localeCompare(b.handle))
          .map((p) => {
            const alive = new Date(p.last_seen_at).getTime() > Date.now() - 60_000;
            const tag = p.session_token === session.sessionToken ? " (you)" : "";
            return (
              <div key={p.session_token} className={`room-side-row ${alive ? "" : "room-muted"}`}>
                <span>{p.ready ? "✓" : "·"}</span>
                <span>@{p.handle}{tag}</span>
              </div>
            );
          })}
      </div>
      <div className="room-side-section">
        <div className="room-side-h">{t("panel.ideas")}</div>
        {sortedIdeas.length === 0 && <div className="room-muted">{t("panel.no_ideas")}</div>}
        {sortedIdeas.map((i) => {
          const c = voteCounts.get(i.id) ?? 0;
          const isPicked = state.room?.picked_idea_ids?.includes(i.id);
          const isWinner = state.room?.winner_idea_id === i.id;
          return (
            <div key={i.id} className="room-side-row">
              <span className="room-mono">#{shortId(i.id)}</span>
              <span className="room-idea-text">
                {isWinner ? "🏆 " : isPicked ? "★ " : ""}{i.text}
              </span>
              {c > 0 && <span className="room-muted">({c})</span>}
            </div>
          );
        })}
      </div>
      {(phase === "persona" || phase === "scope" || phase === "done") && state.persona && (
        <div className="room-side-section">
          <div className="room-side-h">{t("panel.persona")}</div>
          {state.persona.who && <div className="room-side-row"><span className="room-muted">{t("brief.persona_who")}:</span><span>{state.persona.who}</span></div>}
          {state.persona.context && <div className="room-side-row"><span className="room-muted">{t("brief.persona_context")}:</span><span>{state.persona.context}</span></div>}
          {state.persona.pain && <div className="room-side-row"><span className="room-muted">{t("brief.persona_pain")}:</span><span>{state.persona.pain}</span></div>}
        </div>
      )}
      {(phase === "scope" || phase === "done") && state.scope && (
        <div className="room-side-section">
          <div className="room-side-h">{t("panel.scope")}</div>
          {state.scope.must_have.length > 0 && (
            <>
              <div className="room-muted">{t("panel.scope_must")}</div>
              {state.scope.must_have.map((s, i) => (
                <div key={i} className="room-side-row">{i + 1}. {s}</div>
              ))}
            </>
          )}
          {state.scope.nice_to_have.length > 0 && (
            <>
              <div className="room-muted">{t("panel.scope_nice")}</div>
              {state.scope.nice_to_have.map((s, i) => (
                <div key={i} className="room-side-row">{i + 1}. {s}</div>
              ))}
            </>
          )}
          {state.scope.out_of_scope.length > 0 && (
            <>
              <div className="room-muted">{t("panel.scope_out")}</div>
              {state.scope.out_of_scope.map((s, i) => (
                <div key={i} className="room-side-row">{i + 1}. {s}</div>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function BriefView({
  state,
  t,
}: {
  state: RoomState;
  t: ReturnType<typeof makeT>;
}) {
  const { ideas, votes, assessments, room, persona, scope } = state;
  const winner = room?.winner_idea_id ? ideas.get(room.winner_idea_id) : null;
  const sortedIdeas = Array.from(ideas.values()).sort(
    (a, b) => a.created_at.localeCompare(b.created_at)
  );
  const voteCounts = new Map<string, number>();
  for (const v of votes) {
    if (v.phase === "pick_two") voteCounts.set(v.idea_id, (voteCounts.get(v.idea_id) ?? 0) + 1);
  }
  // Assessment summaries for picked ideas
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
    <div className="room-brief">
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
      <div className="brief-line brief-hint">{t("brief.hint_copy")}</div>
      {state.stream.length > 0 && (
        <div className="brief-line brief-stream">{state.stream[state.stream.length - 1]?.text}</div>
      )}
    </div>
  );
}
