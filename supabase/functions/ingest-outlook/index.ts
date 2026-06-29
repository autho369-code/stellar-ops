// ingest-outlook — scheduled email agent.
// Polls unread mail across the configured Outlook mailboxes via Microsoft Graph
// (app-only / client-credentials), turns each new message into an email_doc
// work_item, best-effort tags it to the owner's association, and classifies
// urgency. It writes a DRAFT reply into the mailbox's Drafts ONLY when
// ENABLE_DRAFTS=true — by default it is triage-only (no replies written), so
// the agent can be evaluated before it ever drafts.
//
// Required function secrets:
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   (Azure app registration)
//   OUTLOOK_MAILBOXES  = comma-separated UPNs
// Optional:
//   COMPANY_ID, MAX_PER_MAILBOX (default 10)
//   ENABLE_DRAFTS = "true" to let it draft replies (default OFF — triage only)
//   LLM provider (for triage/drafts): LLM_PROVIDER = anthropic | openai
//     Anthropic:        ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-sonnet-4-6)
//     OpenAI-compatible: OPENAI_API_KEY, OPENAI_MODEL (default gpt-4o-mini), OPENAI_BASE_URL
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_COMPANY = "d31ba98f-d0b3-4513-9246-8b0575edbc83";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

type GraphMessage = {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  webLink: string | null;
  receivedDateTime: string | null;
  from?: { emailAddress?: { address?: string; name?: string } };
};

type Triage = { priority: "emergency" | "urgent" | "routine"; draft: string | null };

const PRIORITY_RULES =
  "emergency = active damage/safety (flooding, fire, no heat, gas). " +
  "urgent = time-sensitive (insurance, legal, board deadline). routine = everything else.";

function systemPrompt(wantDraft: boolean): string {
  const base = "You triage email for Stellar Property Group, an HOA/condo manager. " + PRIORITY_RULES + " ";
  return wantDraft
    ? base +
        'Return STRICT JSON only: {"priority":"emergency|urgent|routine","draft":"a concise, professional reply"}. ' +
        "Keep the draft brief and do not invent facts or commitments."
    : base + 'Return STRICT JSON only: {"priority":"emergency|urgent|routine"}.';
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
  if (explicit === "openai" || explicit === "openai-compatible")
    return Deno.env.get("OPENAI_API_KEY") ? "openai" : null;
  if (Deno.env.get("ANTHROPIC_API_KEY")) return "anthropic";
  if (Deno.env.get("OPENAI_API_KEY")) return "openai";
  return null;
}

async function anthropicComplete(system: string, msg: GraphMessage): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userPrompt(msg) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

async function openaiComplete(system: string, msg: GraphMessage): Promise<string> {
  const base = (Deno.env.get("OPENAI_BASE_URL") ?? DEFAULT_OPENAI_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")!}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL,
      max_tokens: 1024,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt(msg) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function classifyAndDraft(
  provider: "anthropic" | "openai",
  msg: GraphMessage,
  wantDraft: boolean,
): Promise<Triage> {
  try {
    const system = systemPrompt(wantDraft);
    const text = provider === "anthropic" ? await anthropicComplete(system, msg) : await openaiComplete(system, msg);
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const priority = ["emergency", "urgent", "routine"].includes(parsed.priority) ? parsed.priority : "routine";
    return { priority, draft: wantDraft && typeof parsed.draft === "string" ? parsed.draft : null };
  } catch (_) {
    return { priority: "routine", draft: null };
  }
}

async function getGraphToken(tenant: string, clientId: string, secret: string) {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Graph token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token as string;
}

async function createDraftReply(token: string, mailbox: string, messageId: string, body: string): Promise<boolean> {
  try {
    const replyRes = await fetch(
      `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${messageId}/createReply`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!replyRes.ok) return false;
    const draft = await replyRes.json();
    const patchRes = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${draft.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: { contentType: "Text", content: body } }),
    });
    return patchRes.ok;
  } catch (_) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (secret) {
    const provided =
      req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
  }

  const tenant = Deno.env.get("MS_TENANT_ID");
  const clientId = Deno.env.get("MS_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET");
  const mailboxes = (Deno.env.get("OUTLOOK_MAILBOXES") ?? "").split(",").map((m) => m.trim()).filter(Boolean);

  if (!tenant || !clientId || !clientSecret || mailboxes.length === 0) {
    return new Response(
      JSON.stringify({
        configured: false,
        note: "Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and OUTLOOK_MAILBOXES as function secrets.",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const companyId = Deno.env.get("COMPANY_ID") ?? DEFAULT_COMPANY;
  const provider = selectedProvider();
  const draftsEnabled = Deno.env.get("ENABLE_DRAFTS") === "true";
  const maxPer = Number(Deno.env.get("MAX_PER_MAILBOX") ?? 10);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let token: string;
  try {
    token = await getGraphToken(tenant, clientId, clientSecret);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502 });
  }

  let created = 0;
  let drafted = 0;
  let skipped = 0;

  for (const mailbox of mailboxes) {
    const url =
      `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$filter=isRead eq false&$top=${maxPer}&$orderby=receivedDateTime desc` +
      `&$select=id,subject,bodyPreview,from,receivedDateTime,webLink`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const messages: GraphMessage[] = (await res.json()).value ?? [];

    for (const msg of messages) {
      const { data: seen } = await supabase
        .from("processed_emails")
        .select("id")
        .eq("company_id", companyId)
        .eq("graph_message_id", msg.id)
        .maybeSingle();
      if (seen) {
        skipped++;
        continue;
      }

      const fromAddr = msg.from?.emailAddress?.address ?? null;

      let associationId: string | null = null;
      let unitId: string | null = null;
      if (fromAddr) {
        const { data: owner } = await supabase
          .from("owners")
          .select("unit_id, units:unit_id(association_id)")
          .eq("company_id", companyId)
          .ilike("email", fromAddr)
          .maybeSingle();
        if (owner) {
          unitId = (owner as any).unit_id ?? null;
          associationId = (owner as any).units?.association_id ?? null;
        }
      }

      const triage: Triage = provider
        ? await classifyAndDraft(provider, msg, draftsEnabled)
        : { priority: "routine", draft: null };

      let draftCreated = false;
      if (draftsEnabled && triage.draft) {
        draftCreated = await createDraftReply(token, mailbox, msg.id, triage.draft);
        if (draftCreated) drafted++;
      }

      const { data: workItem } = await supabase
        .from("work_items")
        .insert({
          company_id: companyId,
          association_id: associationId,
          unit_id: unitId,
          type: "email_doc",
          title: msg.subject || "(no subject)",
          description: msg.bodyPreview ?? null,
          source_channel: "outlook",
          priority: triage.priority,
          metadata: {
            graph_message_id: msg.id,
            mailbox,
            from: fromAddr,
            web_link: msg.webLink,
            draft_created: draftCreated,
          },
        })
        .select("id")
        .single();

      await supabase.from("processed_emails").insert({
        company_id: companyId,
        graph_message_id: msg.id,
        mailbox,
        subject: msg.subject,
        from_address: fromAddr,
        work_item_id: workItem?.id ?? null,
        draft_created: draftCreated,
      });
      created++;
    }
  }

  return new Response(
    JSON.stringify({
      configured: true,
      provider: provider ?? "none",
      drafts_enabled: draftsEnabled,
      mailboxes: mailboxes.length,
      created,
      drafted,
      skipped,
      at: new Date().toISOString(),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
