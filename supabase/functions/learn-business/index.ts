// learn-business - one-pass "learn the business" job for Arthur.
// READ-ONLY: samples email history across the mailboxes and lists each
// association's Dropbox folder, then writes factual notes into knowledge_notes
// (who emails about what, which vendors serve whom, what documents are on file).
// It never sends, modifies, or deletes mail or files. Replaces prior notes each run.
//
// The heavy work runs in the background (EdgeRuntime.waitUntil) and the request
// returns immediately, so callers (the hub "Learn now" button) don't time out.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_COMPANY = "d31ba98f-d0b3-4513-9246-8b0575edbc83";

async function getGraphToken(tenant: string, clientId: string, secret: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
  return (await res.json()).access_token as string;
}

async function dropboxToken(): Promise<string | null> {
  const key = Deno.env.get("DROPBOX_APP_KEY"), sec = Deno.env.get("DROPBOX_APP_SECRET"), rt = Deno.env.get("DROPBOX_REFRESH_TOKEN");
  if (!key || !sec || !rt) return null;
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: key, client_secret: sec }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}

function topN(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} (${c})`);
}
function bump(map: Map<string, number>, key: string) { map.set(key, (map.get(key) ?? 0) + 1); }

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
}

type AStat = { emails: number; subjects: Map<string, number>; senders: Map<string, number>; vendors: Map<string, number> };
type ADocs = { folders: Set<string>; types: Map<string, number>; files: number };

async function runLearn(source: string, maxPer: number): Promise<void> {
  const doEmail = source === "all" || source === "email";
  const doDropbox = source === "all" || source === "dropbox";

  const companyId = Deno.env.get("COMPANY_ID") ?? DEFAULT_COMPANY;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Lookup data.
  const { data: assocData } = await supabase.from("associations").select("id,name,dropbox_folder_path").eq("company_id", companyId);
  const assocs = (assocData ?? []).map((a: any) => ({ id: a.id, nameLower: String(a.name).toLowerCase() }));
  const folderById = new Map<string, string>((assocData ?? []).filter((a: any) => a.dropbox_folder_path).map((a: any) => [a.id, a.dropbox_folder_path]));

  const { data: ownerRows } = await supabase.from("owners").select("email, units:unit_id(association_id)").eq("company_id", companyId).not("email", "is", null);
  const ownerByEmail = new Map<string, string>();
  for (const o of (ownerRows ?? []) as any[]) { const a = o.units?.association_id; if (o.email && a) ownerByEmail.set(String(o.email).toLowerCase(), a); }

  const { data: vendorRows } = await supabase.from("vendors").select("name,email").eq("company_id", companyId);
  const vendorByEmail = new Map<string, string>((vendorRows ?? []).filter((v: any) => v.email).map((v: any) => [String(v.email).toLowerCase(), v.name]));

  const aStats = new Map<string, AStat>();
  const vStats = new Map<string, number>();
  const aDocs = new Map<string, ADocs>();
  let emailsSampled = 0, mailboxesRead = 0, foldersListed = 0;

  // --- EMAIL pass: owner-email recognition, else association-name mention ----
  if (doEmail) {
    const tenant = Deno.env.get("MS_TENANT_ID"), clientId = Deno.env.get("MS_CLIENT_ID"), clientSecret = Deno.env.get("MS_CLIENT_SECRET");
    const mailboxes = (Deno.env.get("OUTLOOK_MAILBOXES") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    if (tenant && clientId && clientSecret && mailboxes.length) {
      const token = await getGraphToken(tenant, clientId, clientSecret);
      for (const mailbox of mailboxes) {
        const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$top=${maxPer}&$orderby=receivedDateTime desc&$select=from,subject,bodyPreview`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        mailboxesRead++;
        const msgs = (await res.json()).value ?? [];
        for (const msg of msgs) {
          emailsSampled++;
          const from = (msg.from?.emailAddress?.address ?? "").toLowerCase();
          if (from.includes("ooma")) continue; // voicemails, not email content
          const text = `${msg.subject ?? ""} ${msg.bodyPreview ?? ""}`.toLowerCase();
          let aId: string | null = (from && ownerByEmail.get(from)) || null;
          if (!aId) for (const a of assocs) { if (a.nameLower.length >= 6 && text.includes(a.nameLower)) { aId = a.id; break; } }
          const vendor = from ? vendorByEmail.get(from) : undefined;
          if (vendor) bump(vStats, vendor);
          if (aId) {
            const s = aStats.get(aId) ?? { emails: 0, subjects: new Map(), senders: new Map(), vendors: new Map() };
            s.emails++;
            if (msg.subject) bump(s.subjects, String(msg.subject).slice(0, 70));
            if (from) bump(s.senders, from);
            if (vendor) bump(s.vendors, vendor);
            aStats.set(aId, s);
          }
        }
      }
    }
  }

  // --- DROPBOX pass: inventory each association folder ----------------------
  if (doDropbox) {
    const dtoken = await dropboxToken();
    if (dtoken) {
      for (const [aId, folder] of folderById) {
        const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
          method: "POST",
          headers: { Authorization: `Bearer ${dtoken}`, "Dropbox-API-Arg": JSON.stringify({ path: folder, recursive: false, limit: 200 }), "Content-Type": "application/json" },
          body: JSON.stringify({ path: folder, recursive: false, limit: 200 }),
        });
        if (!res.ok) continue;
        foldersListed++;
        const entries = (await res.json()).entries ?? [];
        const d: ADocs = { folders: new Set(), types: new Map(), files: 0 };
        for (const e of entries) {
          if (e[".tag"] === "folder") d.folders.add(e.name);
          else { d.files++; const ext = (e.name.split(".").pop() || "?").toLowerCase(); bump(d.types, ext); }
        }
        aDocs.set(aId, d);
      }
    }
  }

  // --- Build notes ----------------------------------------------------------
  const sourceTag = doEmail && doDropbox ? "email+dropbox" : doEmail ? "email" : "dropbox";
  const notes: any[] = [];
  let assocWithData = 0;

  for (const a of (assocData ?? []) as any[]) {
    const s = aStats.get(a.id);
    const d = aDocs.get(a.id);
    if (!s && !d) continue;
    assocWithData++;
    const parts: string[] = [];
    if (s) {
      parts.push(`Email activity (sample): ${s.emails} messages.`);
      if (s.senders.size) parts.push(`Frequent senders: ${topN(s.senders, 6).join(", ")}.`);
      if (s.subjects.size) parts.push(`Recurring subjects: ${topN(s.subjects, 6).join("; ")}.`);
      if (s.vendors.size) parts.push(`Vendors seen: ${topN(s.vendors, 6).join(", ")}.`);
    }
    if (d) {
      const types = topN(d.types, 8).join(", ");
      parts.push(`Dropbox: ${d.files} files${types ? ` (${types})` : ""}${d.folders.size ? `; subfolders: ${[...d.folders].slice(0, 10).join(", ")}` : ""}.`);
    }
    notes.push({ company_id: companyId, scope: "association", ref_id: a.id, ref_name: a.name, title: a.name, body: parts.join(" "), source: sourceTag });
  }

  if (vStats.size) {
    notes.push({
      company_id: companyId, scope: "general", ref_id: null, ref_name: "Vendors",
      title: "Vendors seen in email", body: `Most active vendors (by sampled emails): ${topN(vStats, 20).join(", ")}.`, source: "email",
    });
  }

  notes.push({
    company_id: companyId, scope: "general", ref_id: null, ref_name: "Overview",
    title: "Business overview",
    body:
      `Learned from a sample of ${emailsSampled} emails across ${mailboxesRead} mailboxes and ${foldersListed} Dropbox folders. ` +
      `${assocWithData} of ${(assocData ?? []).length} associations have recognized activity. ` +
      `This is a factual snapshot; ask about a specific association or vendor for details.`,
    source: sourceTag,
  });

  // Replace prior learned notes for this company.
  await supabase.from("knowledge_notes").delete().eq("company_id", companyId);
  for (let i = 0; i < notes.length; i += 200) await supabase.from("knowledge_notes").insert(notes.slice(i, i + 200));
  await supabase.from("agent_settings").update({ last_learned_at: new Date().toISOString() }).eq("company_id", companyId);
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* none */ }
  const source: string = body.source ?? "all";
  const maxPer = Math.min(Number(body.maxPerMailbox ?? 80), 200);

  // Run the (slow) learning in the background and return right away so the
  // caller never waits on it.
  const work = runLearn(source, maxPer).catch((e) => console.error("learn-business failed:", e));
  // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work);
  else await work;

  return json({ ok: true, started: true, at: new Date().toISOString() });
});
