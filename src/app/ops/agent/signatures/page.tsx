import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/isAdmin";
import { saveSignatures } from "./actions";

export const dynamic = "force-dynamic";

export default async function SignaturesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await isAdmin(supabase, user.id))) redirect("/ops");

  const { data: team } = await supabase
    .from("team_members")
    .select("id, name, email, signature")
    .eq("active", true)
    .order("name");

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-8">
      <header className="mb-6">
        <Link href="/ops/agent" className="text-sm text-neutral-400 hover:text-neutral-700">
          ← Arthur
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-900">Email signatures</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Arthur appends each person&apos;s signature to their draft replies. (Drafts are created through the mail API, which
          doesn&apos;t pull in Outlook&apos;s auto-signature — so we add it here.) Paste each signature once — copy it straight from
          Outlook. Plain text or HTML both work.
        </p>
      </header>

      <form action={saveSignatures} className="space-y-6">
        {(team ?? []).map((m) => (
          <div key={m.id}>
            <label htmlFor={`sig_${m.id}`} className="mb-1 block text-sm font-medium text-neutral-800">
              {m.name} <span className="font-normal text-neutral-400">· {m.email}</span>
            </label>
            <textarea
              id={`sig_${m.id}`}
              name={`sig_${m.id}`}
              rows={5}
              defaultValue={m.signature ?? ""}
              placeholder={`e.g.\n${m.name}\nStellar Property Management\n5107 N. Western Ave Suite #1S, Chicago, IL 60625\n(773) 728-0652`}
              className="w-full rounded-lg border border-neutral-300 p-3 font-mono text-xs text-neutral-800 outline-none focus:border-neutral-900"
            />
          </div>
        ))}

        <div className="flex items-center gap-3 border-t border-neutral-100 pt-5">
          <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800">
            Save signatures
          </button>
          <span className="text-xs text-neutral-400">Applied to new drafts on the next run.</span>
        </div>
      </form>
    </main>
  );
}
