// Types shared between the Supabase wire format and the in-browser reducer.
// Mirrors the schema in supabase/migrations/20260521120000_room_brainstorm.sql.

export type Phase =
  | "brainstorm"
  | "pick_two"
  | "assess"
  | "pick_winner"
  | "persona"
  | "scope"
  | "done";

export type Locale = "en" | "es" | "pt";

export interface Room {
  id: string;
  slug: string;
  phase: Phase;
  locale: Locale;
  picked_idea_ids: string[];
  winner_idea_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface Participant {
  room_id: string;
  session_token: string;
  handle: string;
  joined_at: string;
  last_seen_at: string;
  ready: boolean;
}

export interface Idea {
  id: string;
  room_id: string;
  session_token: string;
  handle: string;
  text: string;
  created_at: string;
}

export interface Vote {
  room_id: string;
  session_token: string;
  idea_id: string;
  phase: "pick_two" | "pick_winner";
  created_at: string;
}

export type AssessmentKind = "feasibility" | "state_of_the_art";
export type Verdict = "yes" | "no" | "maybe";

export interface Assessment {
  id: string;
  room_id: string;
  idea_id: string;
  kind: AssessmentKind;
  session_token: string;
  verdict: Verdict;
  note: string | null;
  created_at: string;
}

export interface Persona {
  room_id: string;
  idea_id: string | null;
  who: string | null;
  context: string | null;
  pain: string | null;
  updated_at: string;
}

export interface Scope {
  room_id: string;
  must_have: string[];
  nice_to_have: string[];
  out_of_scope: string[];
  updated_at: string;
}

// In-memory state held by the reducer. Mirrors the DB but indexed for fast
// lookups and excludes the room_id where it's redundant.
export interface RoomState {
  room: Room | null;
  participants: Map<string, Participant>; // by session_token
  ideas: Map<string, Idea>; // by id
  votes: Vote[];
  assessments: Map<string, Assessment>; // by id
  persona: Persona | null;
  scope: Scope | null;
  // Append-only log of human-readable events, in-memory only (resets on
  // refresh; the canonical "current state" is the DB rows above).
  stream: StreamLine[];
}

export interface StreamLine {
  id: string;
  kind: "info" | "muted" | "error" | "success" | "echo";
  text: string;
  ts: number;
}

export interface SessionData {
  sessionToken: string;
  handle: string | null;
  hostToken?: string;
}
