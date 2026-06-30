import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runAgentNow, saveAgentSettings } from "./actions";
import { LearnButton } from "./LearnButton";
import { isAdmin } from "@/lib/isAdmin";

export const dynamic = "force-dynamic";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DAYS: [number, string][] = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"],
];
const TZS = [
  ["America/Chicago", "Central"],
  ["America/New_York", "Eastern"],
  ["America/Denver", "Mountain"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Phoenix", "Arizona"],
];
const INTERVALS = [5, 10, 15, 30, 60];
const QUIET = [
  [0, "Paused (no overnight checks)"],
  [60, "Once an hour"],
  [120, "Every 2 hours"],
  [240, "Every 4 hours"],
];

function hourLabel(h: number): string {
  const am = h < 12;
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base}:00 ${am ? "AM" : "PM"}`;
}

export default async function AgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = await isAdmin(supabase, user.id);

  const [{ data: settings }, emails, calls, docs, recognized, totalItems, knowledge, modes] =
    await Promise.all([
      supabase.from("agent_settings").select("*").maybeSingle(),
      supabase.from("work_items").select("*", { count: "exact", head: true }).eq("source_channel", "outlook"),
      supabase.from("work_items").select("*", { count: "exact", head: true }).eq("source_channel", "ooma"),
      supabase.from("documents").select("*", { count: "exact", head: true }),
      supabase.from("work_items").select("*", { count: "exact", head: true }).in("source_channel", ["outlook", "ooma"]).not("association_id", "is", null),
      supabase.from("work_items").select("*", { count: "exact", head: true }).in("source_channel", ["outlook", "ooma"]),
      supabase.from("knowledge_notes").select("*", { count: "exact", head: true }),
      supabase.from("team_members").select("agent_mode"),
    ]);

  const s = (settings as any) ?? {};
  const name: string = s.agent_name || "Arthur";
  const tz: string = s.schedule_tz || "America/Chicago";
  const startH: number = s.active_start_hour ?? 7;
  const endH: number = s.active_end_hour ?? 19;
  const interval: number = s.active_interval_min ?? 15;
  const quiet: number = s.quiet_interval_min ?? 0;
  const activeDays = new Set(String(s.active_days ?? "1,2,3,4,5,6,7").split(",").map((d: string) => parseInt(d.trim(), 10)));
  const tzLabel = TZS.find(([v]) => v === tz)?.[1] ?? tz;

  const pct = totalItems.count ? Math.round((100 * (recognized.count ?? 0)) / totalItems.count) : 0;

  const modeCounts = ((modes.data as { agent_mode: string }[]) ?? []).reduce(
    (acc, m) => acc.set(m.agent_mode, (acc.get(m.agent_mode) ?? 0) + 1),
    new Map<string, number>(),
  );
  const totalMailboxes = modes.data?.length ?? 0;
  const fullCount = modeCounts.get("full") ?? 0;
  const draftsLabel =
    fullCount === 0
      ? "Drafts · off (filing only)"
      : fullCount === totalMailboxes
        ? "Drafts · review-only"
        : `Drafts · review-only (${fullCount}/${totalMailboxes} mailboxes)`;

  const stat = (label: string, value: number | string) => (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="text-2xl font-semibold text-neutral-900">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );

  const field = "w-full rounded-lg border border-neutral-300 p-2 text-sm text-neutral-800 outline-none focus:border-neutral-900";

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-8">
      <header className="mb-6">
        <Link href="/ops" className="text-sm text-neutral-400 hover:text-neutral-700">
          ← Operations Hub
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-900 text-lg font-semibold text-white">
            {name.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-neutral-900">{name}</h1>
            <p className="text-sm text-neutral-500">Your operations intake assistant — email, phone, documents.</p>
          </div>
          <Link
            href="/ops/agent/chat"
            className="ml-auto rounded-lg bg-neutral-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            Chat with {name}
          </Link>
        </div>
      </header>

      {/* Status */}
      <div className="mb-6 flex flex-wrap gap-2 text-xs">
        {[
          `Active ${hourLabel(startH)}–${hourLabel(endH)} ${tzLabel}`,
          `Every ${interval} min`,
          quiet > 0 ? `Overnight: every ${quiet} min` : "Overnight: paused",
          "Email · 5 mailboxes",
          "Phone · Ooma",
          "Documents · Dropbox",
          draftsLabel,
        ].map((t) => (
          <span key={t} className="rounded-full bg-green-100 px-2.5 py-1 font-medium text-green-700">{t}</span>
        ))}
      </div>

      {/* Activity */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Emails", emails.count ?? 0)}
        {stat("Calls", calls.count ?? 0)}
        {stat("Docs filed", docs.count ?? 0)}
        {stat("Recognized", `${pct}%`)}
      </div>

      {/* Admin-only banner */}
      {!admin && (
        <div className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-xs text-neutral-600">
          🔒 Arthur&apos;s identity, schedule, and rules are locked to the admin. You can still chat with him and work your queue.
        </div>
      )}

      {/* Run now */}
      {admin && (
        <form action={runAgentNow} className="mb-8">
          <button className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
            Run now
          </button>
          <span className="ml-3 text-xs text-neutral-400">
            Forces an immediate pass, even outside active hours.
            {s.last_run_at ? ` Last run ${new Date(s.last_run_at).toLocaleString()}.` : ""}
          </span>
        </form>
      )}

      {/* Knowledge / learning */}
      <div className="mb-8 rounded-xl border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-800">What {name} has learned</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              {knowledge.count ?? 0} notes from email + Dropbox history.
              {s.last_learned_at ? ` Last learned ${new Date(s.last_learned_at).toLocaleString()}.` : " Not learned yet."}
              {" "}Ask him in chat, e.g. &ldquo;what do you know about Lincoln Park?&rdquo;
            </p>
          </div>
          {admin && <LearnButton />}
        </div>
        <p className="mt-2 text-xs text-neutral-400">
          Read-only: samples recent email and lists Dropbox folders to build a factual snapshot. Re-run after big changes. (Takes a minute.)
        </p>
      </div>

      {admin && (
        <div className="mb-6">
          <Link href="/ops/agent/signatures" className="text-sm font-medium text-blue-600 hover:underline">
            Manage email signatures →
          </Link>
          <span className="ml-2 text-xs text-neutral-400">Added to draft replies per sender.</span>
        </div>
      )}

      {admin && (
      <form action={saveAgentSettings} className="space-y-8">
        {/* Identity */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-neutral-800">Identity</h2>
          <div>
            <label htmlFor="agent_name" className="mb-1 block text-xs font-medium text-neutral-600">Name</label>
            <input id="agent_name" name="agent_name" defaultValue={name} className={field} />
          </div>
          <div>
            <label htmlFor="persona" className="mb-1 block text-xs font-medium text-neutral-600">Personality</label>
            <p className="mb-2 text-xs text-neutral-500">
              How {name} works and carries himself — diligence, tone, judgment. This shapes how he triages and the feel of his
              drafts. It does <span className="font-medium">not</span> sign emails: replies still go out under each person&apos;s own
              Outlook signature.
            </p>
            <textarea id="persona" name="persona" rows={4} defaultValue={s.persona ?? ""} className={field.replace("p-2", "p-3")} />
          </div>
          <div>
            <label htmlFor="llm_provider" className="mb-1 block text-xs font-medium text-neutral-600">Model</label>
            <p className="mb-2 text-xs text-neutral-500">
              Which AI {name} thinks with — for triage, drafts, and chat. Switch any time, no redeploy.
            </p>
            <select id="llm_provider" name="llm_provider" defaultValue={s.llm_provider ?? ""} className={field}>
              <option value="">Auto (uses whichever key is configured)</option>
              <option value="openai">DeepSeek</option>
              <option value="anthropic">Claude (Anthropic) — requires ANTHROPIC_API_KEY secret</option>
            </select>
            <p className="mt-1 text-xs text-amber-600">
              Claude isn&apos;t wired up with a live key yet — picking it will break chat and drafts until an ANTHROPIC_API_KEY secret is added in Supabase. DeepSeek and Auto both work today.
            </p>
          </div>
        </section>

        {/* Schedule */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-neutral-800">Schedule</h2>
          <p className="text-xs text-neutral-500">When {name} checks the inboxes. Outside the active window he uses the overnight setting below.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="schedule_tz" className="mb-1 block text-xs font-medium text-neutral-600">Timezone</label>
              <select id="schedule_tz" name="schedule_tz" defaultValue={tz} className={field}>
                {TZS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="active_start_hour" className="mb-1 block text-xs font-medium text-neutral-600">Active from</label>
              <select id="active_start_hour" name="active_start_hour" defaultValue={startH} className={field}>
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="active_end_hour" className="mb-1 block text-xs font-medium text-neutral-600">Active until</label>
              <select id="active_end_hour" name="active_end_hour" defaultValue={endH} className={field}>
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="active_interval_min" className="mb-1 block text-xs font-medium text-neutral-600">Check every</label>
              <select id="active_interval_min" name="active_interval_min" defaultValue={interval} className={field}>
                {INTERVALS.map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="quiet_interval_min" className="mb-1 block text-xs font-medium text-neutral-600">Overnight / outside active hours</label>
            <select id="quiet_interval_min" name="quiet_interval_min" defaultValue={quiet} className={field}>
              {QUIET.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-neutral-600">Active days</span>
            <div className="flex flex-wrap gap-3">
              {DAYS.map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5 text-sm text-neutral-700">
                  <input type="checkbox" name="active_days" value={v} defaultChecked={activeDays.has(v)} className="h-4 w-4 rounded border-neutral-300" />
                  {l}
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* Judgment */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-neutral-800">Judgment &amp; voice</h2>
          <div>
            <label htmlFor="triage_rules" className="mb-1 block text-xs font-medium text-neutral-600">Triage rules</label>
            <p className="mb-2 text-xs text-neutral-500">How {name} decides emergency / urgent / routine, and what counts as noise.</p>
            <textarea id="triage_rules" name="triage_rules" rows={6} defaultValue={s.triage_rules ?? ""} className={field.replace("p-2", "p-3")} />
          </div>
          <div>
            <label htmlFor="draft_guidance" className="mb-1 block text-xs font-medium text-neutral-600">Reply voice &amp; rules</label>
            <p className="mb-2 text-xs text-neutral-500">How {name} writes draft replies — tone, scope, what to never promise. (No signature: Outlook adds each person&apos;s own.)</p>
            <textarea id="draft_guidance" name="draft_guidance" rows={10} defaultValue={s.draft_guidance ?? ""} className={field.replace("p-2", "p-3")} />
          </div>
        </section>

        <div className="flex items-center gap-3 border-t border-neutral-100 pt-5">
          <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800">
            Save changes
          </button>
          {s.updated_at && (
            <span className="text-xs text-neutral-400">Saved {new Date(s.updated_at).toLocaleString()}</span>
          )}
          <span className="text-xs text-neutral-400">Takes effect on the next run — no deploy needed.</span>
        </div>
      </form>
      )}
    </main>
  );
}
