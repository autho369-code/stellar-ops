"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ChatMsg = { role: "user" | "assistant"; content: string };
export type Proposal = { kind: string; item: string; value: string | null; summary: string };

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
  if (!p?.item) return { ok: false, message: "No item specified." };

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
  } else {
    return { ok: false, message: "That action isn't allowed." };
  }

  const { data, error } = await supabase
    .from("work_items")
    .update(patch)
    .eq("id", p.item)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "Couldn't find that item (it may belong to another association or was already removed)." };

  revalidatePath("/ops");
  return { ok: true, message: "Done — updated in the queue." };
}
