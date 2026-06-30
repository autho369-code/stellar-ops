"use client";

import { useState, useTransition } from "react";
import { learnNow } from "./actions";

// Kicks off the (background) learning job and gives immediate feedback. The job
// finishes server-side ~15s later; the note count updates on the next refresh.
export function LearnButton() {
  const [pending, startTransition] = useTransition();
  const [started, setStarted] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await learnNow();
            setStarted(true);
          })
        }
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "Starting…" : "Learn now"}
      </button>
      {started && !pending && (
        <span className="text-xs text-green-700">
          Started — Arthur is learning. Refresh in ~15s to see the new count.
        </span>
      )}
    </div>
  );
}
