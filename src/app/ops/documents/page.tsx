import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AssociationFilter } from "../_components/AssociationFilter";

export const dynamic = "force-dynamic";

// The subfolder a file lives in = the directory just above the filename.
function folderOf(path: string | null): string {
  if (!path) return "—";
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "—";
}

function when(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ association?: string; review?: string }>;
}) {
  const { association, review } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: associations } = await supabase.from("associations").select("id, name").order("name");
  const names = new Map((associations ?? []).map((a) => [a.id, a.name]));

  let q = supabase
    .from("documents")
    .select("id, filename, storage_path, status, association_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (association) q = q.eq("association_id", association);
  if (review) q = q.eq("status", "needs_review");
  const { data: docs } = await q;

  const { count: reviewCount } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true })
    .eq("status", "needs_review");

  const rows = docs ?? [];

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/ops" className="text-sm text-neutral-400 hover:text-neutral-700">
            ← Operations Hub
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-900">Filed Documents</h1>
          <p className="mt-0.5 text-sm text-neutral-500">
            Every attachment Arthur filed, where it went, and when. {rows.length} shown.
          </p>
        </div>
        <AssociationFilter associations={associations ?? []} />
      </header>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={association ? `/ops/documents?association=${association}` : "/ops/documents"}
          className={`rounded-full px-3 py-1 font-medium ${!review ? "bg-neutral-900 text-white" : "border border-neutral-300 text-neutral-600 hover:bg-neutral-50"}`}
        >
          All
        </Link>
        <Link
          href={association ? `/ops/documents?association=${association}&review=1` : "/ops/documents?review=1"}
          className={`rounded-full px-3 py-1 font-medium ${review ? "bg-amber-500 text-white" : "border border-amber-300 text-amber-700 hover:bg-amber-50"}`}
        >
          Needs review{typeof reviewCount === "number" ? ` (${reviewCount})` : ""}
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Filed</th>
              <th className="px-4 py-2.5 font-medium">Association</th>
              <th className="px-4 py-2.5 font-medium">Document</th>
              <th className="px-4 py-2.5 font-medium">Folder</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                  Nothing filed yet.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} className={d.status === "needs_review" ? "bg-amber-50/40" : ""}>
                <td className="whitespace-nowrap px-4 py-2.5 text-neutral-500">{when(d.created_at)}</td>
                <td className="px-4 py-2.5 text-neutral-700">{d.association_id ? names.get(d.association_id) ?? "—" : "Unrecognized"}</td>
                <td className="px-4 py-2.5 text-neutral-900" title={d.storage_path ?? ""}>{d.filename}</td>
                <td className="px-4 py-2.5 text-neutral-600">{folderOf(d.storage_path)}</td>
                <td className="px-4 py-2.5">
                  {d.status === "needs_review" ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">needs review</span>
                  ) : (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">filed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
