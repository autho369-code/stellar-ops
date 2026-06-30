// ingest-outlook - scheduled email agent.
// For each new operational email: create an email_doc work_item, recognize the
// association (owner email, else association name in subject/body), classify
// urgency (rules from agent_settings), skip noise. If Dropbox is configured and
// the email has document attachments, file them into that association's Dropbox
// folder and log them in `documents`. Drafts only when ENABLE_DRAFTS=true.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_COMPANY = "d31ba98f-d0b3-4513-9246-8b0575edbc83";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const DOC_EXT = ["pdf","doc","docx","xls","xlsx","csv","ppt","pptx","jpg","jpeg","png","gif","heic","bmp","tif","tiff"];
const IMG_EXT = ["jpg","jpeg","png","gif","bmp","tif","tiff","heic"];

type GraphMessage = {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  webLink: string | null;
  hasAttachments?: boolean;
  from?: { emailAddress?: { address?: string; name?: string } };
};

type Triage = { priority: "emergency" | "urgent" | "routine"; isNoise: boolean; draft: string | null; raw: string };

const DEFAULT_RULES =
  "PRIORITY rules: emergency = immediate safety or major damage. urgent = water/roof leaks. routine = everything else. Set is_noise=true for marketing/newsletters/promotional/automated notifications.";

function systemPrompt(rules: string, wantDraft: boolean): string {
  const base = "You triage email for Stellar Property Group, an HOA/condo manager. " + rules + " ";
  return wantDraft
    ? base +
        'Return STRICT JSON only: {"priority":"emergency|urgent|routine","is_noise":true|false,"draft":"a concise, professional reply"}. ' +
        "Keep the draft brief and do not invent facts or commitments."
    : base + 'Return STRICT JSON only: {"priority":"emergency|urgent|routine","is_noise":true|false}.';
}

function userPrompt(msg: GraphMessage): string {
  return (
    `From: ${msg.from?.emailAddress?.address ?? "unknown"}\n` +
    `Subject: ${msg.subject ?? "(no subject)"}\n\n${msg.bodyPreview ?? ""}`
  );
}

function selectedProvider(): "anthropic" | "openai" | null {
  const explicit = Deno.env.get("LLM_PROVIDER")?.toLowerCase();
  if (explicit === "anthropic") return Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : null;
  if (explicit === "openai" || explicit === "openai-compatible") return Deno.env.get("OPENAI_API_KEY") ? "openai" : null;
  if (Deno.env.get("ANTHROPIC_API_KEY")) return "anthropic";
  if (Deno.env.get("OPENAI_API_KEY")) return "openai";
  return null;
}

async function anthropicComplete(system: string, msg: GraphMessage): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: userPrompt(msg) }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).content?.[0]?.text ?? "";
}

async function openaiComplete(system: string, msg: GraphMessage): Promise<string> {
  const base = (Deno.env.get("OPENAI_BASE_URL") ?? DEFAULT_OPENAI_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")!}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL, max_tokens: 1024, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: userPrompt(msg) }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

async function triageEmail(provider: "anthropic" | "openai" | null, msg: GraphMessage, wantDraft: boolean, rules: string): Promise<Triage> {
  if (!provider) return { priority: "routine", isNoise: false, draft: null, raw: "no-provider" };
  try {
    const system = systemPrompt(rules, wantDraft);
    const text = provider === "anthropic" ? await anthropicComplete(system, msg) : await openaiComplete(system, msg);
    const p = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const priority = ["emergency", "urgent", "routine"].includes(p.priority) ? p.priority : "routine";
    return { priority, isNoise: p.is_noise === true, draft: wantDraft && typeof p.draft === "string" ? p.draft : null, raw: text.slice(0, 300) };
  } catch (e) {
    return { priority: "routine", isNoise: false, draft: null, raw: "ERR: " + (e instanceof Error ? e.message : String(e)) };
  }
}

function assocCore(name: string): string {
  return name.toLowerCase()
    .replace(/\b(condominium association|condo association|condominiums?|homeowners? association|hoa|association|inc\.?)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function matchAssociationByText(text: string, assocs: { id: string; nameLower: string; core: string }[]): string | null {
  const t = text.toLowerCase();
  let bestId: string | null = null, bestLen = 0;
  for (const a of assocs) for (const cand of [a.nameLower, a.core]) {
    if (cand && cand.length >= 5 && t.includes(cand) && cand.length > bestLen) { bestId = a.id; bestLen = cand.length; }
  }
  return bestId;
}

const STREET_STOP = new Set(["n","s","e","w","north","south","east","west","ave","av","avenue","st","street","dr","drive","blvd","boulevard","court","ct","rd","road","ln","lane","place","pl","terrace","ter","way","pkwy","parkway","cir","circle","sq","square","chicago","il","unit","apt","suite","ste","floor","fl"]);

// Extract (number, street) pairs from a free-text address or email body.
function addressPairs(text: string): { num: number; street: string }[] {
  const out: { num: number; street: string }[] = [];
  const re = /(\d{2,5})(?:[-&\s]+\d+)*\s+(?:(?:[nsew]|north|south|east|west)\.?\s+)?([a-z][a-z'.]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    const street = m[2].toLowerCase().replace(/[^a-z]/g, "");
    if (street.length >= 4 && !STREET_STOP.has(street)) out.push({ num, street });
  }
  return out;
}

// Match by a building address mentioned in the email (number + street, so
// streets shared by two associations don't collide).
function matchAssociationByAddress(text: string, idx: { id: string; num: number; street: string }[]): string | null {
  for (const p of addressPairs(text)) {
    for (const e of idx) {
      if (e.street === p.street && Math.abs(e.num - p.num) <= 50) return e.id;
    }
  }
  return null;
}

// Ooma voicemail email parsing (sender no_reply@ooma.com).
function parseOoma(body: string): { number: string | null; name: string | null; preview: string | null } {
  const number = body.match(/Caller Number\s*([()\d\s\-+.]{7,})/i)?.[1]?.trim() ?? null;
  const name = body.match(/Caller Name\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const preview = body.split(/Voicemail Preview:/i)[1]?.trim() ?? null;
  return { number, name, preview };
}
// Last 7 digits formatted "ddd-dddd" for an ilike match against stored phones.
function phoneFragment(num: string | null): string | null {
  if (!num) return null;
  const d = num.replace(/\D/g, "");
  if (d.length < 7) return null;
  const l = d.slice(-7);
  return l.slice(0, 3) + "-" + l.slice(3);
}

async function getGraphToken(tenant: string, clientId: string, secret: string) {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Graph token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token as string;
}

async function createDraftReply(token: string, mailbox: string, messageId: string, body: string): Promise<boolean> {
  try {
    const r = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${messageId}/createReply`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const draft = await r.json();
    const p = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${draft.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: { contentType: "Text", content: body } }),
    });
    return p.ok;
  } catch (_) { return false; }
}

// --- Dropbox ----------------------------------------------------------------
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

function dbxArg(obj: unknown): string {
  // Dropbox-API-Arg must be ASCII; escape non-ASCII chars.
  return JSON.stringify(obj).split("").map((ch) => ch.charCodeAt(0) > 127 ? "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0") : ch).join("");
}

async function dropboxUpload(token: string, path: string, bytes: Uint8Array): Promise<string | null> {
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": dbxArg({ path, mode: "add", autorename: true, mute: true }), "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) return null;
  return (await res.json()).path_display ?? path;
}

function isDocAttachment(att: any): boolean {
  if (att["@odata.type"] !== "#microsoft.graph.fileAttachment" || att.isInline) return false;
  const ext = (att.name || "").toLowerCase().split(".").pop() ?? "";
  if (!DOC_EXT.includes(ext)) return false;
  if (IMG_EXT.includes(ext) && (att.size || 0) < 20000) return false; // skip signature/logo images
  return true;
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (secret) {
    const provided = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const tenant = Deno.env.get("MS_TENANT_ID");
  const clientId = Deno.env.get("MS_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET");
  const mailboxes = (Deno.env.get("OUTLOOK_MAILBOXES") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!tenant || !clientId || !clientSecret || mailboxes.length === 0) {
    return new Response(JSON.stringify({ configured: false, note: "Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and OUTLOOK_MAILBOXES as function secrets." }), { headers: { "Content-Type": "application/json" } });
  }

  const companyId = Deno.env.get("COMPANY_ID") ?? DEFAULT_COMPANY;
  const provider = selectedProvider();
  const draftsEnabled = Deno.env.get("ENABLE_DRAFTS") === "true";
  const maxPer = Number(Deno.env.get("MAX_PER_MAILBOX") ?? 10);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: assocData } = await supabase.from("associations").select("id,name,dropbox_folder_path,address").eq("company_id", companyId);
  const assocs = (assocData ?? []).map((a: any) => ({ id: a.id, nameLower: a.name.toLowerCase(), core: assocCore(a.name) }));
  const folderById = new Map<string, string>((assocData ?? []).filter((a: any) => a.dropbox_folder_path).map((a: any) => [a.id, a.dropbox_folder_path]));
  const addrIndex: { id: string; num: number; street: string }[] = [];
  for (const a of (assocData ?? []) as any[]) {
    if (a.address) for (const p of addressPairs(a.address)) addrIndex.push({ id: a.id, num: p.num, street: p.street });
  }

  const { data: vEmails } = await supabase.from("vendors").select("name,email").eq("company_id", companyId).not("email", "is", null);
  const vendorByEmail = new Map<string, string>((vEmails ?? []).map((v: any) => [String(v.email).toLowerCase(), v.name]));

  const { data: settings } = await supabase.from("agent_settings").select("triage_rules").eq("company_id", companyId).maybeSingle();
  const rules = (settings as any)?.triage_rules || DEFAULT_RULES;

  const dbxToken = await dropboxToken();

  let token: string;
  try {
    token = await getGraphToken(tenant, clientId, clientSecret);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502 });
  }

  let created = 0, drafted = 0, skipped = 0, noise = 0, filed = 0, calls = 0;

  for (const mailbox of mailboxes) {
    const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$filter=isRead eq false&$top=${maxPer}&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,from,receivedDateTime,webLink,hasAttachments`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const messages: GraphMessage[] = (await res.json()).value ?? [];

    for (const msg of messages) {
      const { data: seen } = await supabase.from("processed_emails").select("id").eq("company_id", companyId).eq("graph_message_id", msg.id).maybeSingle();
      if (seen) { skipped++; continue; }

      const fromAddr = msg.from?.emailAddress?.address ?? null;

      // --- Ooma voicemail -> 'call' work item, recognized by caller phone ---
      if ((fromAddr ?? "").toLowerCase().includes("ooma")) {
        const oo = parseOoma(msg.bodyPreview ?? "");
        if (!oo.number) {
          // Ooma account/admin notification (not a voicemail) - skip as noise.
          await supabase.from("processed_emails").insert({ company_id: companyId, graph_message_id: msg.id, mailbox, subject: msg.subject, from_address: fromAddr, work_item_id: null, draft_created: false });
          noise++;
          continue;
        }
        const frag = phoneFragment(oo.number);
        let aId: string | null = null, uId: string | null = null, vendorName: string | null = null;
        if (frag) {
          const { data: oList } = await supabase.from("owners").select("unit_id, units:unit_id(association_id)").eq("company_id", companyId).ilike("phone", `%${frag}%`).limit(1);
          const o = oList?.[0] as any;
          if (o) { uId = o.unit_id ?? null; aId = o.units?.association_id ?? null; }
          if (!aId) {
            const { data: vList } = await supabase.from("vendors").select("name").eq("company_id", companyId).ilike("phone", `%${frag}%`).limit(1);
            if (vList?.[0]) vendorName = (vList[0] as any).name;
          }
        }
        const vt = await triageEmail(provider, { ...msg, bodyPreview: oo.preview ?? msg.bodyPreview }, false, rules);
        const { data: wi } = await supabase.from("work_items").insert({
          company_id: companyId, association_id: aId, unit_id: uId,
          type: "call", title: oo.name ? `Voicemail: ${oo.name}` : (msg.subject || "Voicemail"),
          description: msg.bodyPreview ?? null, source_channel: "ooma", priority: vt.priority,
          metadata: { graph_message_id: msg.id, mailbox, caller_number: oo.number, caller_name: oo.name, vendor: vendorName, transcript: oo.preview },
        }).select("id").single();
        await supabase.from("processed_emails").insert({ company_id: companyId, graph_message_id: msg.id, mailbox, subject: msg.subject, from_address: fromAddr, work_item_id: wi?.id ?? null, draft_created: false });
        calls++;
        continue;
      }

      let associationId: string | null = null;
      let unitId: string | null = null;
      if (fromAddr) {
        const { data: owner } = await supabase.from("owners").select("unit_id, units:unit_id(association_id)").eq("company_id", companyId).ilike("email", fromAddr).maybeSingle();
        if (owner) { unitId = (owner as any).unit_id ?? null; associationId = (owner as any).units?.association_id ?? null; }
      }
      if (!associationId) associationId = matchAssociationByText(`${msg.subject ?? ""} ${msg.bodyPreview ?? ""}`, assocs);
      if (!associationId) associationId = matchAssociationByAddress(`${msg.subject ?? ""} ${msg.bodyPreview ?? ""}`, addrIndex);
      const vendorName = fromAddr ? (vendorByEmail.get(fromAddr.toLowerCase()) ?? null) : null;

      const triage = await triageEmail(provider, msg, draftsEnabled, rules);

      if (triage.isNoise && !vendorName) {
        await supabase.from("processed_emails").insert({ company_id: companyId, graph_message_id: msg.id, mailbox, subject: msg.subject, from_address: fromAddr, work_item_id: null, draft_created: false });
        noise++;
        continue;
      }

      let draftCreated = false;
      if (draftsEnabled && triage.draft) {
        draftCreated = await createDraftReply(token, mailbox, msg.id, triage.draft);
        if (draftCreated) drafted++;
      }

      const { data: workItem } = await supabase.from("work_items").insert({
        company_id: companyId, association_id: associationId, unit_id: unitId,
        type: "email_doc", title: msg.subject || "(no subject)", description: msg.bodyPreview ?? null,
        source_channel: "outlook", priority: triage.priority,
        metadata: { graph_message_id: msg.id, mailbox, from: fromAddr, web_link: msg.webLink, draft_created: draftCreated, vendor: vendorName, debug: triage.raw },
      }).select("id").single();

      // File document attachments into the association's Dropbox folder.
      if (msg.hasAttachments && dbxToken && associationId && folderById.get(associationId)) {
        const folder = folderById.get(associationId)!;
        try {
          const ar = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${msg.id}/attachments`, { headers: { Authorization: `Bearer ${token}` } });
          if (ar.ok) {
            const atts = (await ar.json()).value ?? [];
            for (const att of atts) {
              if (!isDocAttachment(att)) continue;
              let bytes: Uint8Array | null = null;
              if (att.contentBytes) {
                const bin = atob(att.contentBytes);
                bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
              } else {
                const v = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${msg.id}/attachments/${att.id}/$value`, { headers: { Authorization: `Bearer ${token}` } });
                if (v.ok) bytes = new Uint8Array(await v.arrayBuffer());
              }
              if (!bytes) continue;
              const stored = await dropboxUpload(dbxToken, `${folder}/Email Attachments/${att.name}`, bytes);
              if (stored) {
                await supabase.from("documents").insert({
                  company_id: companyId, association_id: associationId, work_item_id: workItem?.id ?? null,
                  filename: att.name, doc_type: (att.name.split(".").pop() || "").toLowerCase(), storage_path: stored, classified_by: "agent", status: "filed",
                });
                filed++;
              }
            }
          }
        } catch (_) { /* don't let attachment filing break ingestion */ }
      }

      await supabase.from("processed_emails").insert({ company_id: companyId, graph_message_id: msg.id, mailbox, subject: msg.subject, from_address: fromAddr, work_item_id: workItem?.id ?? null, draft_created: draftCreated });
      created++;
    }
  }

  return new Response(JSON.stringify({ configured: true, provider: provider ?? "none", drafts_enabled: draftsEnabled, dropbox: Boolean(dbxToken), mailboxes: mailboxes.length, created, calls, noise, drafted, filed, skipped, at: new Date().toISOString() }), { headers: { "Content-Type": "application/json" } });
});
