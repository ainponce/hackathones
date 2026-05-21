// Slug + token generation for rooms.
//
// Slugs are short, memorable, easy to read aloud over a call: three lowercase
// words from a small curated dictionary joined by dashes (e.g. "swift-orca-7k").
// Pool size is ~50k combinations — collisions are rare in practice and the
// `rooms.slug UNIQUE` constraint catches the rest; the client retries.
//
// Session and host tokens are 256-bit random hex strings. The session token
// acts as the participant's bearer credential for RLS; the host token is a
// separate secret only the room creator holds, used by `close` to force the
// room into `done`.

const ADJECTIVES = [
  "swift", "amber", "lunar", "neon", "warm", "fizzy", "glassy", "humble",
  "stoic", "vivid", "fuzzy", "crisp", "dusty", "salty", "iron", "ember",
  "dusk", "dawn", "muted", "loud", "sunny", "rainy", "foggy", "windy",
  "kind", "brave", "wild", "snug", "tiny", "giant", "lazy", "agile",
  "feral", "tame", "open", "shy", "bold", "calm", "lean", "rich",
  "sleek", "raw", "pure", "deep", "wide", "tall", "slim", "fast",
];

const NOUNS = [
  "orca", "bear", "tiger", "ferret", "fox", "owl", "wolf", "lion",
  "lynx", "moose", "otter", "panda", "raven", "salmon", "sparrow", "stag",
  "hawk", "eagle", "swan", "crane", "loon", "puma", "shark", "whale",
  "mantis", "moth", "newt", "panther", "rabbit", "raccoon", "robin", "seal",
  "skunk", "snail", "snake", "spider", "squid", "starling", "swift", "turkey",
  "viper", "weasel", "wombat", "yak", "zebra", "cobra", "dolphin", "dragon",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSuffix(): string {
  // ~36^2 = 1296 combinations of [0-9a-z]{2}, enough to keep slug uniqueness
  // dense without making the slug feel long.
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 2; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function generateSlug(): string {
  return [pickRandom(ADJECTIVES), pickRandom(NOUNS), randomSuffix()].join("-");
}

export function generateToken(): string {
  // 32 random bytes = 64 hex chars = 256 bits. crypto.getRandomValues is in
  // every modern browser; this code only runs in the room island.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Lightweight validator so a stray `room join not-a-slug` doesn't make a
// supabase round-trip with garbage.
export function isPlausibleSlug(s: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+){1,4}$/.test(s) && s.length <= 64 && s.length >= 3;
}
