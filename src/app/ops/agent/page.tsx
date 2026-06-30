import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runAgentNow, saveAgentSettings } from "./actions";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: settings }, emails, calls, docs, recognized, totalItems] =
    await Promise.all([
      supabase.from("agent_settings").select("triage_rules, draft_guidance, updated_at").maybeSingle(),
      supabase.from("work_items").select("*", { count: "exact", head: true }).eq("source_channel", "outlook"),
      supabase.from("work_items").select("*", { count: "exact", head: true }).eq("source_channel", "ooma"),
      supabase.from("documents").select("*", { count: "exact", head: true }),
      supabase.from("work_items").select("*", { count: "exact", head: true }).in("source_channel", ["outlook", "ooma"]).not("association_id", "is", null),
      supabase.from("work_items").select("*", { count: "exact", head: true }).in("source_channel", ["outlook", "ooma"]),
    ]);

  const pct = totalItems.count ? Math.round((100 * (recognized.count ?? 0)) / totalItems.count) : 0;

  const stat = (label: string, value: number | string) => (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="text-2xl font-semibold text-neutral-900">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-8">
      <header className="mb-6">
        <Link href="/ops" className="text-sm text-neutral-400 hover:text-neutral-700">
          ← Operations Hub
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-900">Agent</h1>
        <p className="mt-0.5 text-sm text-neutral-500">
          The intake agent runs automatically every 15 minutes across your 5 mailboxes.
        </p>
      </header>

      {/* Status */}
      <div className="mb-6 flex flex-wrap gap-2 text-xs">
        {["Running every 15 min", "Email · 5 mailboxes", "Documents · Dropbox", "Phone · Ooma", "Drafts · review-only"].map((s) => (
          <span key={s} className="rounded-full bg-green-100 px-2.5 py-1 font-medium text-green-700">{s}</span>
        ))}
      </div>

      {/* Activity */}
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Emails", emails.count ?? 0)}
        {stat("Calls", calls.count ?? 0)}
        {stat("Docs filed", docs.count ?? 0)}
        {stat("Recognized", `${pct}%`)}
      </div>

      {/* Run now */}
      <form action={runAgentNow} className="mb-8">
        <button className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
          Run now
        </button>
        <span className="ml-3 text-xs text-neutral-400">Forces an immediate pass (otherwise it runs on the 15-min schedule).</span>
      </form>

      {/* Editable settings */}
      <form action={saveAgentSettings} className="space-y-5">
        <div>
          <label htmlFor="triage_rules" className="mb-1 block text-sm font-medium text-neutral-800">
            Triage rules
          </label>
          <p className="mb-2 text-xs text-neutral-500">How the agent decides emergency / urgent / routine, and what counts as noise.</p>
          <textarea
            id="triage_rules" name="triage_rules" rows={6}
            defaultValue={(settings as any)?.triage_rules ?? ""}
            className="w-full rounded-lg border border-neutral-300 p-3 text-sm text-neutral-800 outline-none focus:border-neutral-900"
          />
        </div>

        <div>
          <label htmlFor="draft_guidance" className="mb-1 block text-sm font-medium text-neutral-800">
            Reply voice & rules
          </label>
          <p className="mb-2 text-xs text-neutral-500">How the agent writes draft replies — tone, scope, what to never promise. (No signature: Outlook adds each person&apos;s own.)</p>
          <textarea
            id="draft_guidance" name="draft_guidance" rows={12}
            defaultValue={(settings as any)?.draft_guidance ?? ""}
            className="w-full rounded-lg border border-neutral-300 p-3 text-sm text-neutral-800 outline-none focus:border-neutral-900"
          />
        </div>

        <div className="flex items-center gap-3">
          <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800">
            Save changes
          </button>
          {(settings as any)?.updated_at && (
            <span className="text-xs text-neutral-400">
              Last updated {new Date((settings as any).updated_at).toLocaleString()}
            </span>
          )}
        </div>
        <p className="text-xs text-neutral-400">Changes take effect on the next run — no deploy needed.</p>
      </form>
    </main>
  );
}
