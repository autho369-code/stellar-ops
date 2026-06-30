"use server";

import { createClient } from "@/lib/supabase/server";

export type ChatMsg = { role: "user" | "assistant"; content: string };

// Forward the conversation to Arthur's chat function, authenticated as the
// signed-in staff member (the function requires a valid JWT).
export async function askArthur(messages: ChatMsg[]): Promise<{ reply?: string; error?: string }> {
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
    return { reply: (data as any).reply ?? "" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Network error reaching Arthur." };
  }
}
