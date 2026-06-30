"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importObligations, type ImportResult } from "./actions";

export function ImportCalendar() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [res, setRes] = useState<ImportResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <section className="mb-8 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">Import a property calendar (CSV / Excel)</h2>
          <p className="mt-0.5 max-w-xl text-xs text-neutral-500">
            Fastest way to load every association at once. Download the template — it already lists each association with the
            standard renewals &amp; inspections. Fill in the <strong>next-due dates</strong> (delete rows that don&apos;t apply), save as
            CSV, and upload. Re-uploading is safe — duplicates are skipped.
          </p>
        </div>
        <a
          href="/ops/recurring/template"
          className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
        >
          ↓ Download template
        </a>
      </div>

      <form
        ref={formRef}
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          startTransition(async () => {
            const r = await importObligations(fd);
            setRes(r);
            formRef.current?.reset();
            router.refresh();
          });
        }}
      >
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="text-sm text-neutral-600 file:mr-3 file:rounded-lg file:border file:border-neutral-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-700 hover:file:bg-neutral-50"
        />
        <button
          disabled={pending}
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "Importing…" : "Import"}
        </button>
      </form>

      {res && (
        <div className="mt-3 text-xs">
          <p className="font-medium text-green-700">
            ✓ Imported {res.imported} obligation{res.imported === 1 ? "" : "s"} (of {res.total} rows).
          </p>
          {res.skipped.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-neutral-500">{res.skipped.length} skipped — see why</summary>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-neutral-500">
                {res.skipped.slice(0, 100).map((s, i) => (
                  <li key={i}>
                    {s.row ? `Row ${s.row}: ` : ""}
                    {s.name && <span className="text-neutral-700">{s.name}</span>} — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
