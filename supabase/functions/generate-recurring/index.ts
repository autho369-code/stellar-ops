// generate-recurring — scheduled function.
// Materializes every due recurring obligation into a work_item (via the
// generate_due_recurring RPC), per company. Run daily.
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
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // One generation pass per company that has obligations.
  const { data: rows, error } = await supabase
    .from("recurring_obligations")
    .select("company_id")
    .eq("active", true);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const companies = [...new Set((rows ?? []).map((r) => r.company_id))];
  let generated = 0;
  for (const company of companies) {
    const { data, error: rpcErr } = await supabase.rpc(
      "generate_due_recurring",
      { p_company: company },
    );
    if (rpcErr) {
      return new Response(JSON.stringify({ error: rpcErr.message, company }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    generated += data ?? 0;
  }

  return new Response(
    JSON.stringify({ companies: companies.length, generated, at: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json" } },
  );
});
