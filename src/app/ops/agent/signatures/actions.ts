"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/isAdmin";

// Save each teammate's email signature (admin only). Fields are named sig_<id>.
export async function saveSignatures(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdmin(supabase, user.id))) return;
  const companyId = user.app_metadata?.company_id as string | undefined;
  if (!companyId) return;

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("sig_")) continue;
    const id = key.slice(4);
    const sig = String(value).trim() || null;
    await supabase.from("team_members").update({ signature: sig }).eq("id", id).eq("company_id", companyId);
  }
  revalidatePath("/ops/agent/signatures");
}
