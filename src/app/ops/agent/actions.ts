"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/isAdmin";

function intOr(v: FormDataEntryValue | null, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Save Arthur's identity, schedule, triage rules and draft voice.
// All of it is read live by the edge agent on its next run — no redeploy.
export async function saveAgentSettings(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const companyId = user?.app_metadata?.company_id as string | undefined;
  if (!companyId || !user) return;
  if (!(await isAdmin(supabase, user.id))) return; // admin-only

  // Days are individual checkboxes (ISO weekday 1=Mon..7=Sun).
  const days = formData
    .getAll("active_days")
    .map((d) => parseInt(String(d), 10))
    .filter((n) => n >= 1 && n <= 7)
    .sort((a, b) => a - b);

  await supabase.from("agent_settings").upsert(
    {
      company_id: companyId,
      agent_name: String(formData.get("agent_name") ?? "Arthur").trim() || "Arthur",
      persona: String(formData.get("persona") ?? "").trim() || null,
      schedule_tz: String(formData.get("schedule_tz") ?? "America/Chicago").trim() || "America/Chicago",
      active_start_hour: intOr(formData.get("active_start_hour"), 7),
      active_end_hour: intOr(formData.get("active_end_hour"), 19),
      active_interval_min: intOr(formData.get("active_interval_min"), 15),
      quiet_interval_min: intOr(formData.get("quiet_interval_min"), 0),
      active_days: (days.length ? days : [1, 2, 3, 4, 5, 6, 7]).join(","),
      triage_rules: String(formData.get("triage_rules") ?? "").trim(),
      draft_guidance: String(formData.get("draft_guidance") ?? "").trim(),
      llm_provider: ["anthropic", "openai"].includes(String(formData.get("llm_provider"))) ? String(formData.get("llm_provider")) : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );
  revalidatePath("/ops/agent");
}

// Trigger an immediate run, bypassing the schedule gate (force: true).
export async function runAgentNow() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdmin(supabase, user.id))) return; // admin-only
  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/ingest-outlook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ force: true }),
  }).catch(() => {});
  revalidatePath("/ops/agent");
  revalidatePath("/ops");
}

// Read-only "learn the business" pass: samples email + Dropbox history and
// rebuilds Arthur's knowledge notes. Authenticated as the signed-in user.
export async function learnNow() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return;
  if (!(await isAdmin(supabase, session.user.id))) return; // admin-only
  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/learn-business`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ source: "all" }),
  }).catch(() => {});
  revalidatePath("/ops/agent");
}
