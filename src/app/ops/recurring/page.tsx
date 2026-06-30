import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { addObligation, generateNow } from "./actions";
import { ImportCalendar } from "./ImportCalendar";

export const dynamic = "force-dynamic";

type Obligation = {
  id: string;
  title: string;
  category: string | null;
  priority: "emergency" | "urgent" | "routine";
  interval_months: number;
  lead_time_days: number;
  next_due_date: string;
  association_id: string | null;
  last_generated_at: string | null;
};

function statusOf(o: Obligation): { label: string; cls: string } {
  const due = new Date(o.next_due_date);
  const leadStart = new Date(due);
  leadStart.setDate(leadStart.getDate() - o.lead_time_days);
  if (Date.now() >= leadStart.getTime())
    return { label: "Generating now", cls: "bg-amber-100 text-amber-700" };
  return { label: "Scheduled", cls: "bg-neutral-100 text-neutral-500" };
}

export default async function RecurringPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: obligations }, { data: associations }] = await Promise.all([
    supabase
      .from("recurring_obligations")
      .select(
        "id, title, category, priority, interval_months, lead_time_days, next_due_date, association_id, last_generated_at",
      )
      .order("next_due_date"),
    supabase.from("associations").select("id, name").order("name"),
  ]);

  const assocName = new Map((associations ?? []).map((a) => [a.id, a.name]));

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/ops" className="text-sm text-neutral-400 hover:text-neutral-700">
            ← Operations Hub
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-900">
            Recurring Obligations
          </h1>
          <p className="mt-0.5 text-sm text-neutral-500">
            Inspections, renewals, and rodding — auto-added to the queue before they’re due.
          </p>
        </div>
        <form action={generateNow}>
          <button className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800">
            Generate due items now
          </button>
        </form>
      </header>

      <ImportCalendar />

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Obligation</th>
              <th className="px-4 py-2.5 font-medium">Association</th>
              <th className="px-4 py-2.5 font-medium">Every</th>
              <th className="px-4 py-2.5 font-medium">Next due</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(obligations ?? []).map((o) => {
              const s = statusOf(o as Obligation);
              return (
                <tr key={o.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-neutral-900">{o.title}</div>
                    {o.category && (
                      <div className="text-xs text-neutral-400">{o.category}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    {o.association_id ? assocName.get(o.association_id) : "—"}
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    {o.interval_months} mo
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    {new Date(o.next_due_date).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
                      {s.label}
                    </span>
                  </td>
                </tr>
              );
            })}
            {(obligations ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-xs text-neutral-400">
                  No recurring obligations yet — add one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add obligation */}
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Add an obligation</h2>
        <form
          action={addObligation}
          className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 bg-white p-4 sm:grid-cols-2"
        >
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Association</span>
            <select
              name="association_id"
              required
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            >
              {(associations ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Title</span>
            <input
              name="title"
              required
              placeholder="e.g. Annual elevator inspection"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Category</span>
            <input
              name="category"
              placeholder="elevator / insurance / fire_safety / plumbing"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Priority</span>
            <select
              name="priority"
              defaultValue="routine"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            >
              <option value="routine">routine</option>
              <option value="urgent">urgent</option>
              <option value="emergency">emergency</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">
              Repeat every (months)
            </span>
            <input
              name="interval_months"
              type="number"
              min={1}
              defaultValue={12}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">
              Lead time (days)
            </span>
            <input
              name="lead_time_days"
              type="number"
              min={0}
              defaultValue={21}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Next due date</span>
            <input
              name="next_due_date"
              type="date"
              required
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex items-end">
            <button className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
              Add obligation
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
