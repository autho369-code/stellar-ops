"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseCsv } from "@/lib/csv";

export type SyncResult = {
  ok: boolean;
  rows: number;
  associations: number;
  units: number;
  owners: number;
  error?: string;
};

// AppFolio (and other) exports use varying column headers. We accept any of
// these aliases (lower-cased) for each field.
const ALIASES: Record<string, string[]> = {
  association_name: ["association_name", "association", "property", "property_name", "property name"],
  association_address: ["association_address", "address", "property_address", "property address"],
  unit_number: ["unit_number", "unit", "unit_id", "unit_no", "unit number"],
  owner_name: ["owner_name", "owner", "name", "owner name", "tenant", "tenant_name"],
  owner_email: ["owner_email", "email", "email_address", "owner email", "email address"],
  owner_phone: ["owner_phone", "phone", "phone_number", "owner phone", "phone 1"],
};

function pick(row: Record<string, string>, key: string): string {
  for (const alias of ALIASES[key]) {
    const v = row[alias];
    if (v != null && v !== "") return v;
  }
  return "";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fail = (error: string): SyncResult => ({
  ok: false,
  rows: 0,
  associations: 0,
  units: 0,
  owners: 0,
  error,
});

// Parses an AppFolio CSV export and upserts associations / units / owners.
// Idempotent: re-running with a fresh export updates existing rows (each unit
// re-points to its current owner) and adds new ones. Bulk upserts keep it fast.
export async function syncAppfolio(
  _prev: SyncResult | null,
  formData: FormData,
): Promise<SyncResult> {
  try {
    const file = formData.get("file") as File | null;
    if (!file || file.size === 0) return fail("Choose a CSV file first.");

    const rows = parseCsv(await file.text());
    if (rows.length === 0) return fail("No rows found in that CSV.");

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const companyId = user?.app_metadata?.company_id as string | undefined;
    if (!companyId) return fail("Your session is missing a company — sign in again.");

    const db = supabase as any; // avoid deep generic instantiation on chained upserts

    // 1) Associations (unique by name)
    const assocByName = new Map<string, { company_id: string; name: string; address: string | null }>();
    for (const r of rows) {
      const name = pick(r, "association_name");
      if (name && !assocByName.has(name)) {
        assocByName.set(name, {
          company_id: companyId,
          name,
          address: pick(r, "association_address") || null,
        });
      }
    }
    const assocIdByName = new Map<string, string>();
    const assocNameById = new Map<string, string>();
    for (const part of chunk([...assocByName.values()], 500)) {
      const { data, error } = await db
        .from("associations")
        .upsert(part, { onConflict: "company_id,name" })
        .select("id,name");
      if (error) throw error;
      for (const a of data) {
        assocIdByName.set(a.name, a.id);
        assocNameById.set(a.id, a.name);
      }
    }

    // 2) Units (unique by association + number)
    const unitByKey = new Map<string, { company_id: string; association_id: string; number: string }>();
    for (const r of rows) {
      const an = pick(r, "association_name");
      const num = pick(r, "unit_number");
      const aid = assocIdByName.get(an);
      if (!aid || !num) continue;
      unitByKey.set(`${aid}::${num}`, { company_id: companyId, association_id: aid, number: num });
    }
    const unitIdByKey = new Map<string, string>();
    for (const part of chunk([...unitByKey.values()], 500)) {
      const { data, error } = await db
        .from("units")
        .upsert(part, { onConflict: "company_id,association_id,number" })
        .select("id,association_id,number");
      if (error) throw error;
      for (const u of data) unitIdByKey.set(`${u.association_id}::${u.number}`, u.id);
    }

    // 3) Owners (unique by email) — tie each to its unit so inbound email can
    //    be matched to the right association.
    const ownerByEmail = new Map<string, any>();
    const ownersNoEmail: any[] = [];
    for (const r of rows) {
      const name = pick(r, "owner_name");
      if (!name) continue;
      const an = pick(r, "association_name");
      const num = pick(r, "unit_number");
      const aid = assocIdByName.get(an);
      const unitId = aid ? unitIdByKey.get(`${aid}::${num}`) ?? null : null;
      const email = pick(r, "owner_email");
      const owner = {
        company_id: companyId,
        name,
        email: email || null,
        phone: pick(r, "owner_phone") || null,
        unit_id: unitId,
      };
      if (email) ownerByEmail.set(email.toLowerCase(), owner);
      else ownersNoEmail.push(owner);
    }
    let ownerCount = 0;
    for (const part of chunk([...ownerByEmail.values()], 500)) {
      const { error } = await db.from("owners").upsert(part, { onConflict: "company_id,email" });
      if (error) throw error;
      ownerCount += part.length;
    }
    // Owners without an email can't be safely de-duplicated; insert as-is.
    for (const part of chunk(ownersNoEmail, 500)) {
      const { error } = await db.from("owners").insert(part);
      if (error) throw error;
      ownerCount += part.length;
    }

    revalidatePath("/ops");
    revalidatePath("/ops/import");
    return {
      ok: true,
      rows: rows.length,
      associations: assocIdByName.size,
      units: unitIdByKey.size,
      owners: ownerCount,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Sync failed.");
  }
}
