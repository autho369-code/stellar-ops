// daily-digest — scheduled function (STUB).
// Will email each staff member their open queue + today's overdue/emergencies.
//
// TODO: wire up the email provider before enabling.
//   1. Pick a provider (Resend recommended: https://resend.com) and add its
//      key as a function secret:  supabase secrets set RESEND_API_KEY=...
//   2. Replace the buildAndSend() body below with a real send call.
//   3. Schedule this function daily (see README / Supabase scheduled functions).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (secret) {
    const provided =
      req.headers.get("x-cron-secret") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const nowIso = new Date().toISOString();
  const { data: overdue } = await supabase
    .from("work_items")
    .select("id, title, priority, due_date, owner_user_id")
    .lt("due_date", nowIso)
    .neq("status", "done");

  const { data: emergencies } = await supabase
    .from("work_items")
    .select("id, title, due_date")
    .eq("priority", "emergency")
    .neq("status", "done");

  // TODO: replace with real email send once RESEND_API_KEY (or your provider's
  // key) is configured. For now we just report what *would* be sent.
  const emailKey = Deno.env.get("RESEND_API_KEY");
  const payload = {
    generated_at: nowIso,
    overdue_count: overdue?.length ?? 0,
    emergency_count: emergencies?.length ?? 0,
    email_provider_configured: Boolean(emailKey),
    note: emailKey
      ? "Provider key present — implement buildAndSend()."
      : "TODO: set RESEND_API_KEY to enable sending.",
  };

  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
});
