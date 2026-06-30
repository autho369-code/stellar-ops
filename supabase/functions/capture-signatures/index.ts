// capture-signatures - best-effort: read each mailbox's recent SENT emails and
// extract the person's signature block with the LLM, saving it to team_members.
// Skips anyone who already has a signature unless {overwrite:true}. Read-only on
// mail; only writes the signature field. Always review results in the hub after.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_COMPANY = "d31ba98f-d0b3-4513-9246-8b0575edbc83";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

function selectedProvider(): "anthropic" | "openai" | null {
  const explicit = Deno.env.get("LLM_PROVIDER")?.toLowerCase();
  if (explicit === "anthropic") return Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : null;
  if (explicit === "openai" || explicit === "openai-compatible") return Deno.env.get("OPENAI_API_KEY") ? "openai" : null;
  if (Deno.env.get("ANTHROPIC_API_KEY")) return "anthropic";
  if (Deno.env.get("OPENAI_API_KEY")) return "openai";
  return null;
}

async function llmText(provider: "anthropic" | "openai", system: string, user: string): Promise<string> {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL, max_tokens: 400, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    return (await res.json()).content?.[0]?.text ?? "";
  }
  const base = (Deno.env.get("OPENAI_BASE_URL") ?? DEFAULT_OPENAI_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")!}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL, max_tokens: 400, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

async function getGraphToken(tenant: string, clientId: string, secret: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
  return (await res.json()).access_token as string;
}

function htmlToText(h: string): string {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>(?=)/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;/gi, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractSignature(provider: "anthropic" | "openai", text: string): Promise<string | null> {
  const system =
    "Below is the text of an email a person sent. Extract ONLY their email signature block — name, title, company, address, phone, email, website, and any standard closing lines. " +
    "Exclude the greeting, the message body, and any quoted or replied-to text below the signature. Return it as clean plain text with one item per line. If there is no clear signature, reply with exactly NONE.";
  try {
    const out = (await llmText(provider, system, text)).trim();
    if (/^none$/i.test(out) || out.length < 12) return null;
    return out;
  } catch (_) { return null; }
}

function json(o: unknown, s = 200): Response {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* */ }
  const overwrite = body.overwrite === true;

  const companyId = Deno.env.get("COMPANY_ID") ?? DEFAULT_COMPANY;
  const tenant = Deno.env.get("MS_TENANT_ID"), clientId = Deno.env.get("MS_CLIENT_ID"), clientSecret = Deno.env.get("MS_CLIENT_SECRET");
  const mailboxes = (Deno.env.get("OUTLOOK_MAILBOXES") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!tenant || !clientId || !clientSecret || !mailboxes.length) return json({ error: "graph not configured" }, 500);

  const provider = selectedProvider();
  if (!provider) return json({ error: "no llm provider" }, 500);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: team } = await supabase.from("team_members").select("id,email,signature").eq("company_id", companyId);
  const byEmail = new Map<string, any>((team ?? []).map((t: any) => [String(t.email).toLowerCase(), t]));

  let token: string;
  try { token = await getGraphToken(tenant, clientId, clientSecret); } catch (e) { return json({ error: String(e) }, 502); }

  const results: Record<string, string> = {};
  for (const mailbox of mailboxes) {
    const tm = byEmail.get(mailbox.toLowerCase());
    if (!tm) { results[mailbox] = "not on roster"; continue; }
    if (tm.signature && !overwrite) { results[mailbox] = "already set (skipped)"; continue; }

    const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages?$top=6&$select=subject,body`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { results[mailbox] = `graph ${r.status}`; continue; }
    const msgs = (await r.json()).value ?? [];

    let captured: string | null = null;
    for (const m of msgs) {
      const text = htmlToText(m.body?.content ?? "").slice(0, 3500);
      if (text.length < 40) continue;
      captured = await extractSignature(provider, text);
      if (captured) break;
    }
    if (captured) {
      await supabase.from("team_members").update({ signature: captured }).eq("id", tm.id);
      results[mailbox] = "captured";
    } else {
      results[mailbox] = "no signature found";
    }
  }

  return json({ ok: true, results });
});
