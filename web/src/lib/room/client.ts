// Per-room Supabase client. Each participant ships an `x-session-token`
// header on every request; RLS policies treat that header as the bearer
// credential. The host additionally ships `x-host-token` so the
// SECURITY DEFINER `close_room()` function can verify it.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "./types";

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

export function hasSupabaseEnv(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

export function makeRoomClient(opts: {
  sessionToken: string;
  hostToken?: string;
}): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY");
  }
  const headers: Record<string, string> = {
    "x-session-token": opts.sessionToken,
  };
  if (opts.hostToken) headers["x-host-token"] = opts.hostToken;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

export const ROOM_SESSION_KEY = (slug: string) => `room:${slug}:session`;

export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "es" || saved === "pt" || saved === "en") return saved;
  } catch {}
  return "en";
}
