// Generate the markdown rendering of a completed room's brief.
// Used by the [c] keybind on the done screen and by `leave` when the host
// closes the room. The text is the canonical handoff artifact — no DB row,
// no link, just markdown the user can paste anywhere.

import type { RoomState } from "./types";

export function buildBriefMarkdown(state: RoomState): string {
  const { room, ideas, votes, assessments, persona, scope, participants } = state;
  if (!room) return "";

  const winnerIdea = room.winner_idea_id ? ideas.get(room.winner_idea_id) : null;
  const allIdeas = Array.from(ideas.values()).sort(
    (a, b) => a.created_at.localeCompare(b.created_at)
  );

  const voteCounts = new Map<string, number>();
  for (const v of votes) {
    if (v.phase === "pick_two") {
      voteCounts.set(v.idea_id, (voteCounts.get(v.idea_id) ?? 0) + 1);
    }
  }

  const ideaLines = allIdeas.map((i) => {
    const c = voteCounts.get(i.id) ?? 0;
    const marker = winnerIdea?.id === i.id ? "🏆" : c > 0 ? "✅" : "•";
    return `- ${marker} **${i.text}** (${c} votes) — _by ${i.handle}_`;
  });

  const assessLines: string[] = [];
  for (const ideaId of room.picked_idea_ids) {
    const idea = ideas.get(ideaId);
    if (!idea) continue;
    const buckets = { feasibility: { yes: 0, no: 0, maybe: 0, notes: [] as string[] }, state_of_the_art: { yes: 0, no: 0, maybe: 0, notes: [] as string[] } };
    for (const a of assessments.values()) {
      if (a.idea_id !== ideaId) continue;
      const b = buckets[a.kind];
      b[a.verdict] += 1;
      if (a.note) b.notes.push(a.note);
    }
    assessLines.push(`### ${idea.text}`);
    assessLines.push(`- feasibility: ${buckets.feasibility.yes} yes / ${buckets.feasibility.maybe} maybe / ${buckets.feasibility.no} no`);
    if (buckets.feasibility.notes.length)
      assessLines.push(`  - notes: ${buckets.feasibility.notes.map((n) => `"${n}"`).join(", ")}`);
    assessLines.push(`- state of the art: ${buckets.state_of_the_art.yes} yes / ${buckets.state_of_the_art.maybe} maybe / ${buckets.state_of_the_art.no} no`);
    if (buckets.state_of_the_art.notes.length)
      assessLines.push(`  - notes: ${buckets.state_of_the_art.notes.map((n) => `"${n}"`).join(", ")}`);
  }

  const lines: string[] = [];
  lines.push(`# Brainstorm brief — ${room.slug}`);
  lines.push("");
  lines.push(`Date: ${new Date(room.created_at).toISOString().slice(0, 10)}`);
  lines.push(`Participants: ${Array.from(participants.values()).map((p) => `@${p.handle}`).join(", ") || "(none)"}`);
  lines.push("");

  if (winnerIdea) {
    lines.push(`## 🏆 Winning idea`);
    lines.push(`> ${winnerIdea.text}`);
    lines.push("");
  }

  lines.push(`## Ideas (${allIdeas.length})`);
  if (ideaLines.length) lines.push(...ideaLines); else lines.push("- _(none)_");
  lines.push("");

  if (assessLines.length) {
    lines.push(`## Assessment`);
    lines.push(...assessLines);
    lines.push("");
  }

  if (persona && (persona.who || persona.context || persona.pain)) {
    lines.push(`## Persona`);
    if (persona.who) lines.push(`- **who**: ${persona.who}`);
    if (persona.context) lines.push(`- **context**: ${persona.context}`);
    if (persona.pain) lines.push(`- **pain**: ${persona.pain}`);
    lines.push("");
  }

  if (scope && (scope.must_have.length || scope.nice_to_have.length || scope.out_of_scope.length)) {
    lines.push(`## Scope`);
    if (scope.must_have.length) {
      lines.push(`### Must have`);
      scope.must_have.forEach((s) => lines.push(`- ${s}`));
    }
    if (scope.nice_to_have.length) {
      lines.push(`### Nice to have`);
      scope.nice_to_have.forEach((s) => lines.push(`- ${s}`));
    }
    if (scope.out_of_scope.length) {
      lines.push(`### Out of scope`);
      scope.out_of_scope.forEach((s) => lines.push(`- ${s}`));
    }
    lines.push("");
  }

  return lines.join("\n");
}
