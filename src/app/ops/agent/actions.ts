"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Save the agent's triage rules and draft voice (read live by the edge agent).
export async function saveAgentSettings(formData: FormData) {
  const triage_rules = String(formData.get("triage_rules") ?? "").trim();
  const draft_guidance = String(formData.get("draft_guidance") ?? "").trim();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const companyId = user?.app_metadata?.company_id as string | undefined;
  if (!companyId) return;

  await supabase
    .from("agent_settings")
    .upsert(
      { company_id: companyId, triage_rules, draft_guidance, updated_at: new Date().toISOString() },
      { onConflict: "company_id" },
    );
  revalidatePath("/ops/agent");
}

// Trigger an immediate agent run (otherwise it runs every 15 min on schedule).
export async function runAgentNow() {
  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/ingest-outlook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}` },
  }).catch(() => {});
  revalidatePath("/ops/agent");
  revalidatePath("/ops");
}
