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

// Column aliases (lower-cased). Supports AppFolio's "homeowner directory"
// export (Property / Unit / Homeowner / Phone Numbers / Emails) as well as a
// simpler split-column format.
const COL = {
  property: ["property", "association", "association_name", "property_name", "property name"],
  address: ["association_address", "address", "property_address", "property address"],
  unit: ["unit", "unit_number", "unit_id", "unit_no", "unit number"],
  owner: ["homeowner", "owner", "owner_name", "owner name", "name", "tenant", "tenant_name"],
  email: ["emails", "email", "owner_email", "email_address", "owner email", "email address"],
  phone: ["phone numbers", "phone_numbers", "phone", "owner_phone", "phone_number", "owner phone"],
};

const field = (row: Record<string, string>, aliases: string[]): string => {
  for (const a of aliases) {
    const v = row[a];
    if (v != null && v !== "") return v;
  }
  return "";
};
const hasCol = (rows: Record<string, string>[], aliases: string[]): boolean =>
  rows.length > 0 && aliases.some((a) => a in rows[0]);

// "Avers - Ainslie Condominium Association - 4855 N Avers..." → split at the
// " - " that precedes the street number, so names containing " - " survive.
function splitProp(p: string): [string, string] {
  p = p.trim();
  const m = p.match(/^(.*?) - (\d.*)$/);
  if (m) return [m[1].replace(/^["']|["']$/g, "").trim(), m[2].trim()];
  const d = p.indexOf(" - ");
  if (d >= 0) return [p.slice(0, d).replace(/^["']|["']$/g, "").trim(), p.slice(d + 3).trim()];
  return [p.replace(/^["']|["']$/g, "").trim(), ""];
}

function cleanPhones(cell: string): string {
  const list = cell
    .split(/[,;]/)
    .map((p) => p.replace(/^\s*(home|mobile|office|work|fax|cell|phone)\s*:\s*/i, "").trim())
    .filter(Boolean);
  return [...new Set(list)].join(", ");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fail = (error: string): SyncResult => ({ ok: false, rows: 0, associations: 0, units: 0, owners: 0, error });

// Parses an AppFolio export and upserts associations / units / owners as the
// agents' recognition table. Idempotent and non-destructive (re-running updates
// existing records and adds new ones). Bulk upserts keep ~1,300 units fast.
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
    const addrColumnPresent = hasCol(rows, COL.address);

    // Aggregate the CSV into associations / units / owner rows.
    const assocAddr = new Map<string, string | null>();
    const unitSet = new Map<string, { name: string; number: string }>();
    type OwnerRow = { assoc: string; unit: string; name: string; email: string | null; phone: string | null };
    const ownerRows: OwnerRow[] = [];

    for (const r of rows) {
      const propCell = field(r, COL.property).trim();
      const unit = field(r, COL.unit).trim();
      const owner = field(r, COL.owner).replace(/^&\s*/, "").replace(/\s+/g, " ").trim();
      // Skip footer / blank rows (e.g. "Total,,,,,,").
      if (!propCell || propCell.toLowerCase() === "total" || (!unit && !owner)) continue;

      const [aName, aAddr] = addrColumnPresent
        ? [propCell.replace(/^["']|["']$/g, "").trim(), field(r, COL.address) || ""]
        : splitProp(propCell);
      if (!aName) continue;

      if (!assocAddr.has(aName)) assocAddr.set(aName, aAddr || null);
      if (unit) unitSet.set(`${aName}::${unit}`, { name: aName, number: unit });

      const phone = cleanPhones(field(r, COL.phone)) || null;
      const emails = field(r, COL.email)
        .split(/[,;]/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@"));

      if (emails.length) {
        for (const email of emails) ownerRows.push({ assoc: aName, unit, name: owner || "Owner", email, phone });
      } else if (unit) {
        ownerRows.push({ assoc: aName, unit, name: owner || "Owner", email: null, phone });
      }
    }

    // 1) Associations
    const assocIdByName = new Map<string, string>();
    const assocRows = [...assocAddr.entries()].map(([name, address]) => ({ company_id: companyId, name, address }));
    for (const part of chunk(assocRows, 200)) {
      const { data, error } = await db
        .from("associations")
        .upsert(part, { onConflict: "company_id,name" })
        .select("id,name");
      if (error) throw error;
      for (const a of data) assocIdByName.set(a.name, a.id);
    }

    // 2) Units
    const unitIdByKey = new Map<string, string>();
    const unitRows = [...unitSet.values()]
      .map((u) => ({ company_id: companyId, association_id: assocIdByName.get(u.name), number: u.number }))
      .filter((u) => u.association_id);
    for (const part of chunk(unitRows, 500)) {
      const { data, error } = await db
        .from("units")
        .upsert(part, { onConflict: "company_id,association_id,number" })
        .select("id,association_id,number");
      if (error) throw error;
      for (const u of data) unitIdByKey.set(`${u.association_id}::${u.number}`, u.id);
    }

    // 3) Owners — dedupe by email (last wins); keep null-email rows.
    const byEmail = new Map<string, any>();
    const noEmail: any[] = [];
    for (const o of ownerRows) {
      const aid = assocIdByName.get(o.assoc);
      const unitId = aid ? unitIdByKey.get(`${aid}::${o.unit}`) ?? null : null;
      const row = { company_id: companyId, name: o.name, email: o.email, phone: o.phone, unit_id: unitId };
      if (o.email) byEmail.set(o.email, row);
      else noEmail.push(row);
    }
    let ownerCount = 0;
    for (const part of chunk([...byEmail.values()], 500)) {
      const { error } = await db.from("owners").upsert(part, { onConflict: "company_id,email" });
      if (error) throw error;
      ownerCount += part.length;
    }
    for (const part of chunk(noEmail, 500)) {
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
