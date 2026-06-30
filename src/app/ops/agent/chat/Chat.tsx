"use client";

import { useEffect, useRef, useState } from "react";
import { askArthur, runAction, type ChatMsg, type Proposal } from "./actions";

const SUGGESTIONS = [
  "What came in today?",
  "Anything urgent or overdue?",
  "Summarize the latest voicemails",
  "Claim the newest emergency for me",
];

type Bubble = ChatMsg & {
  proposal?: Proposal | null;
  actionState?: "pending" | "running" | "done" | "failed";
  actionNote?: string;
};

export function Chat({ name }: { name: string }) {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    const history: ChatMsg[] = [...messages.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: clean }];
    setMessages((m) => [...m, { role: "user", content: clean }]);
    setInput("");
    setBusy(true);
    const res = await askArthur(history);
    setBusy(false);
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        content: res.reply || `⚠️ ${res.error ?? "No response."}`,
        proposal: res.proposal ?? null,
        actionState: res.proposal ? "pending" : undefined,
      },
    ]);
  }

  async function confirm(index: number) {
    const p = messages[index]?.proposal;
    if (!p) return;
    setMessages((m) => m.map((b, i) => (i === index ? { ...b, actionState: "running" } : b)));
    const res = await runAction(p);
    setMessages((m) =>
      m.map((b, i) => (i === index ? { ...b, actionState: res.ok ? "done" : "failed", actionNote: res.message } : b)),
    );
  }

  function dismiss(index: number) {
    setMessages((m) => m.map((b, i) => (i === index ? { ...b, actionState: "done", actionNote: "Dismissed." } : b)));
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-2xl border border-neutral-200 bg-white">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-8 text-center">
            <p className="text-sm text-neutral-500">
              Ask {name} what&apos;s come in, what needs attention, or tell him to claim, prioritize, or close an item — he&apos;ll
              ask you to confirm before anything changes.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex flex-col items-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[80%] self-end whitespace-pre-wrap rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm text-white"
                  : "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-2.5 text-sm text-neutral-800"
              }
            >
              {m.content}
            </div>

            {/* Action proposal card */}
            {m.proposal && (
              <div className="mt-2 w-full max-w-[80%] rounded-xl border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs font-medium text-amber-900">
                  {name} wants to: {m.proposal.summary || describe(m.proposal)}
                </div>
                {m.actionState === "pending" && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => confirm(i)}
                      className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => dismiss(i)}
                      className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-white"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
                {m.actionState === "running" && <div className="mt-2 text-xs text-neutral-500">Applying…</div>}
                {(m.actionState === "done" || m.actionState === "failed") && (
                  <div className={`mt-2 text-xs ${m.actionState === "failed" ? "text-red-600" : "text-green-700"}`}>
                    {m.actionState === "failed" ? "⚠️ " : "✓ "}
                    {m.actionNote}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-2.5 text-sm text-neutral-400">
              {name} is thinking…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 border-t border-neutral-100 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Message ${name}…`}
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-neutral-900"
        />
        <button
          disabled={busy || !input.trim()}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function describe(p: Proposal): string {
  const n = p.items?.length ?? 0;
  const noun = `${n} item${n === 1 ? "" : "s"}`;
  if (p.kind === "claim") return `assign ${noun} to you`;
  if (p.kind === "assign") return `assign ${noun} to the chosen teammate`;
  if (p.kind === "set_status") return `set ${noun} to ${p.value}`;
  if (p.kind === "set_priority") return `set ${noun} to ${p.value} priority`;
  return `update ${noun}`;
}
