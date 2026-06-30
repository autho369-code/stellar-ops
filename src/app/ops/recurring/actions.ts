"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseCsv } from "@/lib/csv";

export type ImportResult = {
  imported: number;
  total: number;
  skipped: { row: number; name: string; reason: string }[];
};

// Normalize an association name for fuzzy matching (drops legal suffixes/punct).
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(condominium association|condo association|condominiums?|homeowners? association|hoa|association|apartments?|condo|inc\.?)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Accepts YYYY-MM-DD or M/D/YYYY (Excel's US default) -> 'YYYY-MM-DD' or null.
function parseDate(s: string): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = "20" + y;
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

// Runs the generator for the caller's company (same RPC the cron uses).
export async function generateNow(): Promise<{ count: number; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_due_recurring", { p_company: null });
  revalidatePath("/ops/recurring");
  revalidatePath("/ops");
  return { count: typeof data === "number" ? data : 0, error: error?.message ?? null };
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

// Bulk-import a property calendar from CSV. Matches associations by name,
// validates dates, skips duplicates (same association + title) and undated rows.
export async function importObligations(formData: FormData): Promise<ImportResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const companyId = user?.app_metadata?.company_id as string | undefined;
  if (!companyId) return { imported: 0, total: 0, skipped: [{ row: 0, name: "", reason: "Not signed in." }] };

  const file = formData.get("file");
  const text = file && typeof (file as File).text === "function" ? await (file as File).text() : String(formData.get("csv") ?? "");
  if (!text.trim()) return { imported: 0, total: 0, skipped: [{ row: 0, name: "", reason: "Empty file." }] };

  const rows = parseCsv(text);

  const { data: assocs } = await supabase.from("associations").select("id,name").eq("company_id", companyId);
  const byName = new Map<string, string>();
  for (const a of assocs ?? []) {
    byName.set(normName(a.name), a.id);
    byName.set(a.name.toLowerCase().trim(), a.id);
  }

  const { data: existing } = await supabase.from("recurring_obligations").select("association_id,title").eq("company_id", companyId);
  const seen = new Set((existing ?? []).map((o: any) => `${o.association_id}::${String(o.title).toLowerCase().trim()}`));

  const toInsert: any[] = [];
  const skipped: ImportResult["skipped"] = [];

  rows.forEach((r, i) => {
    const rowNum = i + 2; // +1 for header, +1 for 1-based
    const assocRaw = (r["association"] || r["association_name"] || "").trim();
    const title = (r["title"] || r["obligation"] || "").trim();
    const dateRaw = (r["next_due_date"] || r["due_date"] || r["next_due"] || "").trim();
    if (!assocRaw && !title && !dateRaw) return; // blank line

    const aid = byName.get(normName(assocRaw)) || byName.get(assocRaw.toLowerCase());
    if (!aid) return skipped.push({ row: rowNum, name: assocRaw || title, reason: `Unknown association "${assocRaw}"` }), undefined;
    if (!title) return skipped.push({ row: rowNum, name: assocRaw, reason: "Missing title" }), undefined;
    const date = parseDate(dateRaw);
    if (!date) return skipped.push({ row: rowNum, name: `${assocRaw} – ${title}`, reason: dateRaw ? `Bad date "${dateRaw}"` : "No date yet" }), undefined;
    const key = `${aid}::${title.toLowerCase()}`;
    if (seen.has(key)) return skipped.push({ row: rowNum, name: `${assocRaw} – ${title}`, reason: "Already exists" }), undefined;
    seen.add(key);

    const interval = parseInt(r["interval_months"] || r["every_months"] || "12", 10);
    const lead = parseInt(r["lead_time_days"] || r["lead_days"] || "21", 10);
    const priority = (r["priority"] || "routine").toLowerCase();
    toInsert.push({
      company_id: companyId,
      association_id: aid,
      title,
      category: (r["category"] || "").trim() || null,
      description: (r["description"] || "").trim() || null,
      priority: ["emergency", "urgent", "routine"].includes(priority) ? priority : "routine",
      interval_months: Number.isFinite(interval) && interval > 0 ? interval : 12,
      lead_time_days: Number.isFinite(lead) && lead >= 0 ? lead : 21,
      next_due_date: date,
    });
  });

  let imported = 0;
  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200);
    const { error } = await supabase.from("recurring_obligations").insert(batch);
    if (error) skipped.push({ row: 0, name: "", reason: "Database: " + error.message });
    else imported += batch.length;
  }

  revalidatePath("/ops/recurring");
  revalidatePath("/ops");
  return { imported, total: rows.length, skipped };
}
