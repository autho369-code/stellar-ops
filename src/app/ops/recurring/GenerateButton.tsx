"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateNow } from "./actions";

export function GenerateButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="text-right">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMsg(null);
            const r = await generateNow();
            setMsg(r.error ? `Failed: ${r.error}` : r.count > 0 ? `✓ Generated ${r.count} item${r.count === 1 ? "" : "s"}.` : "No obligations are due yet.");
            router.refresh();
          })
        }
        className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
      >
        {pending ? "Generating…" : "Generate due items now"}
      </button>
      {msg && <p className="mt-1.5 text-xs text-neutral-500">{msg}</p>}
    </div>
  );
}
