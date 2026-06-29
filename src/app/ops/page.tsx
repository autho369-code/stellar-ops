import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../login/actions";
import { AssociationFilter } from "./_components/AssociationFilter";
import { QueueColumn } from "./_components/QueueColumn";
import type { WorkItem } from "./_components/types";

export const dynamic = "force-dynamic";

const WORK_ITEM_COLUMNS =
  "id, type, title, description, source_channel, status, priority, owner_user_id, association_id, due_date, created_at, metadata";

export default async function OpsDashboard({
  searchParams,
}: {
  searchParams: Promise<{ association?: string }>;
}) {
  const { association } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const nowIso = new Date().toISOString();

  // Association list for the filter + id -> name lookup.
  const { data: associations } = await supabase
    .from("associations")
    .select("id, name")
    .order("name");
  const associationNames = new Map(
    (associations ?? []).map((a) => [a.id, a.name]),
  );

  // `any` here intentionally: the Supabase builder's generics overflow the
  // type checker when composed in a helper. Results are cast back below.
  const workItems = () => supabase.from("work_items").select(WORK_ITEM_COLUMNS);
  const byAssociation = (q: any) =>
    association ? q.eq("association_id", association) : q;

  // Queues, queried in parallel.
  const [incoming, myQueue, overdue, emergencies] = await Promise.all([
    byAssociation(
      workItems()
        .is("owner_user_id", null)
        .eq("status", "open")
        .order("due_date", { ascending: true, nullsFirst: false }),
    ),
    byAssociation(
      workItems()
        .eq("owner_user_id", user.id)
        .in("status", ["open", "in_progress"])
        .order("due_date", { ascending: true, nullsFirst: false }),
    ),
    byAssociation(
      workItems()
        .lt("due_date", nowIso)
        .neq("status", "done")
        .order("due_date", { ascending: true }),
    ),
    byAssociation(
      workItems()
        .eq("priority", "emergency")
        .neq("status", "done")
        .order("due_date", { ascending: true, nullsFirst: false }),
    ),
  ]);

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            Operations Hub
          </h1>
          <p className="mt-0.5 text-sm text-neutral-500">{user.email}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/ops/recurring"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
          >
            Recurring
          </Link>
          <AssociationFilter associations={associations ?? []} />
          <form action={signOut}>
            <button className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 xl:grid-cols-4">
        <QueueColumn
          title="Incoming"
          items={(incoming.data as WorkItem[]) ?? []}
          associationNames={associationNames}
          currentUserId={user.id}
          emptyText="Inbox clear — nothing waiting to be claimed."
        />
        <QueueColumn
          title="My Queue"
          items={(myQueue.data as WorkItem[]) ?? []}
          associationNames={associationNames}
          currentUserId={user.id}
          emptyText="Nothing assigned to you."
        />
        <QueueColumn
          title="Overdue"
          accent="red"
          items={(overdue.data as WorkItem[]) ?? []}
          associationNames={associationNames}
          currentUserId={user.id}
          emptyText="Nothing overdue. "
        />
        <QueueColumn
          title="Today's Emergencies"
          accent="red"
          items={(emergencies.data as WorkItem[]) ?? []}
          associationNames={associationNames}
          currentUserId={user.id}
          emptyText="No emergencies."
        />
      </div>
    </main>
  );
}
