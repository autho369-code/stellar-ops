"use client";

import { useEffect, useRef, useState } from "react";
import { askArthur, type ChatMsg } from "./actions";

const SUGGESTIONS = [
  "What came in today?",
  "Anything urgent or overdue?",
  "Summarize the latest voicemails",
  "Which items aren't recognized to an association?",
];

export function Chat({ name }: { name: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    const next: ChatMsg[] = [...messages, { role: "user", content: clean }];
    setMessages(next);
    setInput("");
    setBusy(true);
    const res = await askArthur(next);
    setBusy(false);
    setMessages((m) => [...m, { role: "assistant", content: res.reply || `⚠️ ${res.error ?? "No response."}` }]);
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-2xl border border-neutral-200 bg-white">
      {/* Transcript */}
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-8 text-center">
            <p className="text-sm text-neutral-500">
              Ask {name} about what&apos;s come in, what needs attention, or have him draft a reply.
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
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm text-white"
                  : "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-2.5 text-sm text-neutral-800"
              }
            >
              {m.content}
            </div>
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

      {/* Composer */}
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
