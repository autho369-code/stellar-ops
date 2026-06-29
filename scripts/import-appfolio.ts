/**
 * import-appfolio.ts
 *
 * Imports associations / units / owners from a CSV you export out of AppFolio
 * (Reports → export to CSV), so you never have to pay the $5/resident API fee.
 *
 * Expected columns (header row, case-insensitive):
 *   association_name, association_address, unit_number,
 *   owner_name, owner_email, owner_phone
 *
 * Run:  npx tsx scripts/import-appfolio.ts
 * Reads env from .env.local and ./data/appfolio-export.csv.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const COMPANY_ID = "d31ba98f-d0b3-4513-9246-8b0575edbc83";

// --- minimal .env.local loader (no dependency) --------------------------------
function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* env may already be set in the shell */
  }
}

// --- tiny RFC-4180-ish CSV parser (handles quoted fields/commas) --------------
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) =>
    Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? "").trim()])),
  );
}

async function main() {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  const csvPath = resolve(process.cwd(), "data", "appfolio-export.csv");
  const records = parseCsv(readFileSync(csvPath, "utf8"));
  console.log(`Parsed ${records.length} rows from ${csvPath}`);

  // Caches so we upsert each association/unit once.
  const associationIds = new Map<string, string>();
  const unitIds = new Map<string, string>();
  let owners = 0;

  for (const r of records) {
    const assocName = r["association_name"];
    if (!assocName) continue;

    // Association
    let associationId = associationIds.get(assocName);
    if (!associationId) {
      const { data, error } = await supabase
        .from("associations")
        .upsert(
          {
            company_id: COMPANY_ID,
            name: assocName,
            address: r["association_address"] || null,
          },
          { onConflict: "company_id,name", ignoreDuplicates: false },
        )
        .select("id")
        .single();
      if (error) throw error;
      associationId = data!.id as string;
      associationIds.set(assocName, associationId);
    }

    // Unit
    const unitKey = `${assocName}::${r["unit_number"]}`;
    let unitId = unitIds.get(unitKey);
    if (!unitId && r["unit_number"]) {
      const { data, error } = await supabase
        .from("units")
        .upsert(
          {
            company_id: COMPANY_ID,
            association_id: associationId,
            number: r["unit_number"],
          },
          { onConflict: "company_id,association_id,number" },
        )
        .select("id")
        .single();
      if (error) throw error;
      unitId = data!.id as string;
      unitIds.set(unitKey, unitId);
    }

    // Owner
    if (r["owner_name"]) {
      const { data: owner, error } = await supabase
        .from("owners")
        .upsert(
          {
            company_id: COMPANY_ID,
            name: r["owner_name"],
            email: r["owner_email"] || null,
            phone: r["owner_phone"] || null,
            unit_id: unitId ?? null,
          },
          { onConflict: "company_id,email" },
        )
        .select("id")
        .single();
      if (error) throw error;
      owners++;
      if (unitId && owner) {
        await supabase.from("units").update({ owner_id: owner.id }).eq("id", unitId);
      }
    }
  }

  console.log(
    `Done. Associations: ${associationIds.size}, Units: ${unitIds.size}, Owners: ${owners}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
