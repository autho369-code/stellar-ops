import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Chat } from "./Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: settings } = await supabase.from("agent_settings").select("agent_name").maybeSingle();
  const name = (settings as any)?.agent_name || "Arthur";

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-8">
      <header className="mb-5">
        <Link href="/ops/agent" className="text-sm text-neutral-400 hover:text-neutral-700">
          ← {name}
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-900 text-lg font-semibold text-white">
            {name.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Chat with {name}</h1>
            <p className="text-sm text-neutral-500">He can see your live queues. He can advise and draft — he won&apos;t send or change anything.</p>
          </div>
        </div>
      </header>

      <Chat name={name} />
    </main>
  );
}
