"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Runs the generator for the caller's company (same RPC the cron uses).
export async function generateNow() {
  const supabase = await createClient();
  await supabase.rpc("generate_due_recurring", { p_company: null });
  revalidatePath("/ops/recurring");
  revalidatePath("/ops");
}

export async function addObligation(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const companyId = user?.app_metadata?.company_id as string | undefined;
  if (!companyId) return;

  const associationId = String(formData.get("association_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const nextDue = String(formData.get("next_due_date") ?? "");
  if (!associationId || !title || !nextDue) return;

  await supabase.from("recurring_obligations").insert({
    company_id: companyId,
    association_id: associationId,
    title,
    description: String(formData.get("description") ?? "") || null,
    category: String(formData.get("category") ?? "") || null,
    priority: String(formData.get("priority") ?? "routine"),
    interval_months: Number(formData.get("interval_months") ?? 12),
    lead_time_days: Number(formData.get("lead_time_days") ?? 21),
    next_due_date: nextDue,
  });

  revalidatePath("/ops/recurring");
}
