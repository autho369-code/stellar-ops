// agent-chat - lets Stellar staff talk to Arthur directly inside the hub.
// Loads his name/persona + a live snapshot of the operations queues, then
// answers using the configured LLM provider. Read + advise + draft only; it
// does not send mail or mutate data.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_COMPANY = "d31ba98f-d0b3-4513-9246-8b0575edbc83";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

type Msg = { role: "user" | "assistant"; content: string };

function selectedProvider(): "anthropic" | "openai" | null {
  const explicit = Deno.env.get("LLM_PROVIDER")?.toLowerCase();
  if (explicit === "anthropic") return Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : null;
  if (explicit === "openai" || explicit === "openai-compatible") return Deno.env.get("OPENAI_API_KEY") ? "openai" : null;
  if (Deno.env.get("ANTHROPIC_API_KEY")) return "anthropic";
  if (Deno.env.get("OPENAI_API_KEY")) return "openai";
  return null;
}

async function callAnthropic(system: string, msgs: Msg[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL, max_tokens: 1024, system, messages: msgs }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).content?.[0]?.text ?? "";
}

async function callOpenai(system: string, msgs: Msg[]): Promise<string> {
  const base = (Deno.env.get("OPENAI_BASE_URL") ?? DEFAULT_OPENAI_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")!}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL, max_tokens: 1024, temperature: 0.3, messages: [{ role: "system", content: system }, ...msgs] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

// A compact, live snapshot of the queues so Arthur can answer real questions.
async function buildContext(supabase: any, companyId: string): Promise<string> {
  const nowIso = new Date().toISOString();
  const [assoc, team, knowledge, obligations, filedDocs, recent, openC, overdueC, emergC, draftC] = await Promise.all([
    supabase.from("associations").select("id,name").eq("company_id", companyId),
    supabase.from("team_members").select("id,name").eq("company_id", companyId).eq("active", true).order("name"),
    supabase.from("knowledge_notes").select("scope,ref_name,body").eq("company_id", companyId),
    supabase.from("recurring_obligations").select("title,category,next_due_date,interval_months,association_id").eq("company_id", companyId).eq("active", true).order("next_due_date", { ascending: true, nullsFirst: false }),
    supabase.from("documents").select("filename,storage_path,association_id,created_at").eq("company_id", companyId).order("created_at", { ascending: false }).limit(25),
    supabase.from("work_items").select("id,title,type,priority,status,source_channel,association_id,assigned_to,due_date,created_at,metadata").eq("company_id", companyId).order("created_at", { ascending: false }).limit(30),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).is("owner_user_id", null).eq("status", "open"),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).lt("due_date", nowIso).neq("status", "done"),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).eq("priority", "emergency").neq("status", "done"),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "open").contains("metadata", { draft_created: true }),
  ]);
  const names = new Map<string, string>((assoc.data ?? []).map((a: any) => [a.id, a.name]));
  const teamById = new Map<string, string>((team.data ?? []).map((t: any) => [t.id, t.name]));
  const lines = (recent.data ?? []).map((w: any) => {
    const who = w.association_id ? names.get(w.association_id) ?? "unrecognized" : "unrecognized";
    const drafted = w.metadata?.draft_created ? ", draft ready" : "";
    const assignee = w.assigned_to ? `, assigned to ${teamById.get(w.assigned_to) ?? "someone"}` : "";
    return `- id=${w.id} [${w.priority}/${w.status}] ${w.title} (${w.source_channel}, ${who}${drafted}${assignee})`;
  }).join("\n");
  const roster = (team.data ?? []).map((t: any) => `- id=${t.id} ${t.name}`).join("\n");

  // Learned business knowledge (from the learn-business job).
  const kn = (knowledge.data ?? []) as any[];
  const general = kn.filter((n) => n.scope === "general").map((n) => `${n.ref_name}: ${n.body}`);
  const assocNotes = kn.filter((n) => n.scope === "association").map((n) => `- ${n.ref_name}: ${n.body}`);
  let learned = "";
  if (kn.length) {
    learned = "\n\nBUSINESS KNOWLEDGE (learned from email + Dropbox history; factual snapshot):\n" +
      general.join("\n") + (general.length ? "\n" : "") + assocNotes.join("\n");
    if (learned.length > 24000) learned = learned.slice(0, 24000) + " ...(truncated)";
  }

  // Recurring obligations (renewals & inspections) — the source of truth for
  // "when is X due". Empty until the team enters them.
  const obs = (obligations.data ?? []) as any[];
  const obLines = obs.map((o) => {
    const who = o.association_id ? names.get(o.association_id) ?? "?" : "(all/general)";
    return `- ${who}: ${o.title}${o.category ? ` [${o.category}]` : ""} — next due ${o.next_due_date ?? "unset"}${o.interval_months ? `, every ${o.interval_months} months` : ""}`;
  }).join("\n");
  const obligationsBlock =
    "\n\nRECURRING OBLIGATIONS (renewals & inspections being tracked — this is the ONLY source for due dates):\n" +
    (obLines || "(none entered yet — no renewal or inspection dates are being tracked. If asked when something is due, say it isn't tracked yet and should be added on the Recurring page.)");

  // Documents the agent has filed into Dropbox (so Arthur can say what/where).
  const docs = (filedDocs.data ?? []) as any[];
  const docLines = docs.map((d) => {
    const who = d.association_id ? names.get(d.association_id) ?? "?" : "(unrecognized)";
    return `- ${who}: ${d.filename} -> ${d.storage_path ?? "?"}`;
  }).join("\n");
  const docsBlock =
    "\n\nRECENTLY FILED DOCUMENTS (attachments you filed into Dropbox, newest first):\n" +
    (docLines || "(none filed yet)");

  return (
    "OPERATIONS CONTEXT (live snapshot):\n" +
    `Unclaimed open items: ${openC.count ?? 0} | Overdue: ${overdueC.count ?? 0} | Open emergencies: ${emergC.count ?? 0} | Drafts waiting in Outlook: ${draftC.count ?? 0}\n` +
    "TEAM (assignable):\n" + (roster || "(none)") + "\n\n" +
    "Recent items (newest first):\n" + (lines || "(nothing yet)") +
    obligationsBlock +
    docsBlock +
    learned
  );
}

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const messages: Msg[] = Array.isArray(body.messages)
    ? body.messages.filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-12)
    : [];
  if (!messages.length) return json({ error: "no messages" }, 400);

  const companyId = Deno.env.get("COMPANY_ID") ?? DEFAULT_COMPANY;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: settings } = await supabase.from("agent_settings").select("agent_name,persona").eq("company_id", companyId).maybeSingle();
  const name = (settings as any)?.agent_name || "Arthur";
  const persona = (settings as any)?.persona || "";

  let context = "";
  try { context = await buildContext(supabase, companyId); } catch (_) { context = "OPERATIONS CONTEXT: (unavailable)"; }

  const system =
    `You are ${name}, the operations assistant for Stellar Property Group, an HOA/condo property manager. ${persona ? persona + " " : ""}` +
    "You are chatting with Stellar staff inside the internal operations hub. Use the live OPERATIONS CONTEXT below to answer questions about what has come in, what is urgent or overdue, to summarize voicemails and emails, and to draft replies when asked. " +
    "The BUSINESS KNOWLEDGE section below is what you have ALREADY LEARNED from the firm's email and Dropbox history. When asked what you know or learned (including 'what did you learn from Dropbox'), answer directly and confidently from it — summarize the associations, file counts, document types, vendors, and recurring topics. " +
    "Do NOT say you lack access to Dropbox, a file system, or the user's computer: you have this learned snapshot (folder names, file counts, document types per association). The ONLY thing you lack is the text inside individual files, so mention that limitation only if asked to read the contents of a specific document. " +
    "Be concise, practical, and specific. " +
    "Never invent facts, dates, names, unit numbers, or commitments that are not supported by the context.\n\n" +
    "ACTIONS: You may propose ONE action covering one or more items from the context when the staff member clearly asks you to take/claim, assign, change status, or change priority. " +
    "To propose, end your message with a single line exactly like:\n" +
    '@@ACTION {"kind":"set_status","items":["<id>","<id>"],"value":"done","summary":"Mark 2 items done"}@@\n' +
    "Allowed kinds: set_status (value in [open,in_progress,escalated,done]); set_priority (value in [emergency,urgent,routine]); claim (no value — assigns to the signed-in staff member); assign (value = a TEAM id from the roster — assigns to that teammate). " +
    "`items` is an array of the exact id= values from the context; include every item the request covers (this is how bulk actions work — e.g. all the duplicate requests). " +
    "Phrase your sentence as a proposal (e.g. 'Want me to assign all 3 to Amina?') because the staff member must confirm before it runs. One action kind per reply. " +
    "When assigning to a person, match the name to a TEAM id from the roster; if the name is not on the roster, say so instead of guessing. " +
    "You CANNOT send or finalize emails — drafts are reviewed and sent by a person from Outlook; if asked to send, say so.\n\n" +
    context;

  const provider = selectedProvider();
  if (!provider) return json({ error: "No LLM provider configured." }, 500);
  try {
    let reply = provider === "anthropic" ? await callAnthropic(system, messages) : await callOpenai(system, messages);

    // Pull out an optional @@ACTION {...}@@ proposal; the hub confirms + runs it.
    let proposal: { kind: string; items: string[]; value: string | null; summary: string } | null = null;
    const m = reply.match(/@@ACTION\s*(\{[\s\S]*?\})\s*@@/);
    if (m) {
      try {
        const a = JSON.parse(m[1]);
        const items: string[] = Array.isArray(a.items)
          ? a.items.filter((x: unknown) => typeof x === "string")
          : (typeof a.item === "string" ? [a.item] : []);
        if (items.length && ["set_status", "set_priority", "claim", "assign"].includes(a.kind)) {
          proposal = { kind: a.kind, items, value: typeof a.value === "string" ? a.value : null, summary: typeof a.summary === "string" ? a.summary : "" };
        }
      } catch (_) { /* ignore malformed proposals */ }
      reply = reply.replace(m[0], "").trim();
    }

    return json({ agent: name, reply, proposal });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
