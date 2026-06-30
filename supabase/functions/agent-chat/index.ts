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
  const [assoc, recent, openC, overdueC, emergC, draftC] = await Promise.all([
    supabase.from("associations").select("id,name").eq("company_id", companyId),
    supabase.from("work_items").select("title,type,priority,status,source_channel,association_id,due_date,created_at,metadata").eq("company_id", companyId).order("created_at", { ascending: false }).limit(30),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).is("owner_user_id", null).eq("status", "open"),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).lt("due_date", nowIso).neq("status", "done"),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).eq("priority", "emergency").neq("status", "done"),
    supabase.from("work_items").select("*", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "open").contains("metadata", { draft_created: true }),
  ]);
  const names = new Map<string, string>((assoc.data ?? []).map((a: any) => [a.id, a.name]));
  const lines = (recent.data ?? []).map((w: any) => {
    const who = w.association_id ? names.get(w.association_id) ?? "unrecognized" : "unrecognized";
    const drafted = w.metadata?.draft_created ? ", draft ready" : "";
    return `- [${w.priority}/${w.status}] ${w.title} (${w.source_channel}, ${who}${drafted})`;
  }).join("\n");
  return (
    "OPERATIONS CONTEXT (live snapshot):\n" +
    `Unclaimed open items: ${openC.count ?? 0} | Overdue: ${overdueC.count ?? 0} | Open emergencies: ${emergC.count ?? 0} | Drafts waiting in Outlook: ${draftC.count ?? 0}\n` +
    "Recent items (newest first):\n" + (lines || "(nothing yet)")
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
    "Be concise, practical, and specific. When asked to do something you cannot do from chat (actually send an email, mark an item done, change a setting), explain exactly what you would do and tell them where in the hub to do it. " +
    "Never invent facts, dates, names, unit numbers, or commitments that are not supported by the context.\n\n" +
    context;

  const provider = selectedProvider();
  if (!provider) return json({ error: "No LLM provider configured." }, 500);
  try {
    const reply = provider === "anthropic" ? await callAnthropic(system, messages) : await callOpenai(system, messages);
    return json({ agent: name, reply });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
