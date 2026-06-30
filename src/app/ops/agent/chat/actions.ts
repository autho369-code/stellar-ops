"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ChatMsg = { role: "user" | "assistant"; content: string };
export type Proposal = { kind: string; items: string[]; value: string | null; summary: string };

// Forward the conversation to Arthur's chat function, authenticated as the
// signed-in staff member (the function requires a valid JWT).
export async function askArthur(
  messages: ChatMsg[],
): Promise<{ reply?: string; proposal?: Proposal | null; error?: string }> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { error: "You are signed out. Refresh and sign in again." };

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/agent-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ messages: messages.slice(-12) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (data as any).error || `Arthur is unavailable (${res.status}).` };
    return { reply: (data as any).reply ?? "", proposal: (data as any).proposal ?? null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Network error reaching Arthur." };
  }
}

const STATUS = ["open", "in_progress", "escalated", "done"];
const PRIORITY = ["emergency", "urgent", "routine"];

// Execute a proposal Arthur made, after the staff member confirms it. Only
// reversible internal state changes are allowed — never sends or deletes.
// RLS guarantees the row belongs to the caller's company.
export async function runAction(p: Proposal): Promise<{ ok: boolean; message: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "You are signed out." };

  const items = (p?.items ?? []).filter((x) => typeof x === "string" && x);
  if (!items.length) return { ok: false, message: "No items specified." };

  const patch: Record<string, unknown> = {};
  if (p.kind === "set_status" && STATUS.includes(p.value ?? "")) {
    patch.status = p.value;
    patch.completed_at = p.value === "done" ? new Date().toISOString() : null;
    if (p.value !== "escalated") patch.escalated_at = null;
  } else if (p.kind === "set_priority" && PRIORITY.includes(p.value ?? "")) {
    patch.priority = p.value;
  } else if (p.kind === "claim") {
    patch.owner_user_id = user.id;
    patch.status = "in_progress";
  } else if (p.kind === "assign") {
    if (!p.value) return { ok: false, message: "No teammate specified." };
    // RLS scopes this to the caller's company, so a valid row means it's theirs.
    const { data: tm } = await supabase.from("team_members").select("id").eq("id", p.value).maybeSingle();
    if (!tm) return { ok: false, message: "That teammate isn't on the roster." };
    patch.assigned_to = tm.id;
  } else {
    return { ok: false, message: "That action isn't allowed." };
  }

  const { data, error } = await supabase
    .from("work_items")
    .update(patch)
    .in("id", items)
    .select("id");

  if (error) return { ok: false, message: error.message };
  const n = data?.length ?? 0;
  if (!n) return { ok: false, message: "Couldn't find those items (they may belong to another association or were already removed)." };

  revalidatePath("/ops");
  return {
    ok: true,
    message:
      n === items.length
        ? `Done — updated ${n} item${n === 1 ? "" : "s"}.`
        : `Updated ${n} of ${items.length} (the rest weren't found).`,
  };
}
