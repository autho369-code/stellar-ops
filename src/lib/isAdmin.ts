import type { SupabaseClient } from "@supabase/supabase-js";

// True only if the signed-in user is linked to a roster entry with role 'admin'.
// Used to gate who can change Arthur's identity, schedule, and rules.
export async function isAdmin(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("team_members")
    .select("role")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return (data as { role?: string } | null)?.role === "admin";
}
