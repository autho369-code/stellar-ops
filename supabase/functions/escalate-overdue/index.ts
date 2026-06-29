// escalate-overdue — scheduled function.
// Flips any past-due, still-open work item to status = 'escalated' so nothing
// rots silently in the queue. Intended to run daily via Supabase scheduled
// functions / pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  // Simple shared-secret guard (verify_jwt is off so cron can call it).
  const secret = Deno.env.get("CRON_SECRET");
  if (secret) {
    const provided =
      req.headers.get("x-cron-secret") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("work_items")
    .update({ status: "escalated", escalated_at: nowIso })
    .lt("due_date", nowIso)
    .eq("status", "open")
    .select("id");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ escalated: data?.length ?? 0, at: nowIso }),
    { headers: { "Content-Type": "application/json" } },
  );
});
