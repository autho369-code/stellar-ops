import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ImportForm } from "./_components/ImportForm";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ count: associations }, { count: units }, { count: owners }] =
    await Promise.all([
      supabase.from("associations").select("*", { count: "exact", head: true }),
      supabase.from("units").select("*", { count: "exact", head: true }),
      supabase.from("owners").select("*", { count: "exact", head: true }),
    ]);

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-8">
      <header className="mb-8">
        <Link href="/ops" className="text-sm text-neutral-400 hover:text-neutral-700">
          ← Operations Hub
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-900">
          Sync from AppFolio
        </h1>
        <p className="mt-0.5 text-sm text-neutral-500">
          Upload your latest CSV export to refresh associations, units, and owners.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-3">
        {[
          { label: "Associations", value: associations ?? 0 },
          { label: "Units", value: units ?? 0 },
          { label: "Owners", value: owners ?? 0 },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="text-2xl font-semibold text-neutral-900">{s.value}</div>
            <div className="text-xs text-neutral-500">{s.label}</div>
          </div>
        ))}
      </div>

      <ImportForm />

      <section className="mt-8 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500">
        <p className="mb-2 font-medium text-neutral-700">What to upload</p>
        <p>
          Your AppFolio <strong>Homeowner Directory</strong> CSV export works as-is —
          columns <code>Property</code>, <code>Unit</code>, <code>Homeowner</code>,{" "}
          <code>Phone Numbers</code>, <code>Emails</code> (multiple emails/phones per
          cell are split automatically, and the footer row is ignored). Re-upload anytime;
          existing records update and new ones are added. If a different export uses other
          headers, send a sample and we’ll map them.
        </p>
      </section>
    </main>
  );
}
