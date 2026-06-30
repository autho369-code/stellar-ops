import { WorkItemCard } from "./WorkItemCard";
import type { WorkItem } from "./types";

export function QueueColumn({
  title,
  accent,
  items,
  associationNames,
  teamNames,
  currentUserId,
  emptyText,
}: {
  title: string;
  accent?: "red";
  items: WorkItem[];
  associationNames: Map<string, string>;
  teamNames: Map<string, string>;
  currentUserId: string;
  emptyText: string;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            accent === "red"
              ? "bg-red-100 text-red-700"
              : "bg-neutral-100 text-neutral-500"
          }`}
        >
          {items.length}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-xs text-neutral-400">
            {emptyText}
          </p>
        ) : (
          items.map((item) => (
            <WorkItemCard
              key={item.id}
              item={item}
              associationName={
                item.association_id
                  ? associationNames.get(item.association_id)
                  : undefined
              }
              assigneeName={
                item.assigned_to ? teamNames.get(item.assigned_to) : undefined
              }
              isMine={item.owner_user_id === currentUserId}
            />
          ))
        )}
      </div>
    </section>
  );
}
