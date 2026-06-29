"use client";

import { useActionState } from "react";
import { syncAppfolio, type SyncResult } from "../actions";

export function ImportForm() {
  const [state, action, pending] = useActionState<SyncResult | null, FormData>(
    syncAppfolio,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-6">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="block w-full text-sm text-neutral-700 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-neutral-800"
        />
        <p className="mt-3 text-xs text-neutral-400">
          Drop your latest AppFolio export here. Re-running is safe — existing
          records update, new ones are added.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>

      {state && !state.ok && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state && state.ok && (
        <div className="rounded-lg bg-green-50 px-3 py-2.5 text-sm text-green-800">
          Synced {state.rows} rows → {state.associations} associations,{" "}
          {state.units} units, {state.owners} owners.
        </div>
      )}
    </form>
  );
}
