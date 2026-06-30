import { updateWorkItem } from "../actions";
import type { WorkItem } from "./types";

const PRIORITY_STYLES: Record<WorkItem["priority"], string> = {
  emergency: "bg-red-100 text-red-700",
  urgent: "bg-amber-100 text-amber-700",
  routine: "bg-neutral-100 text-neutral-500",
};

const TYPE_LABELS: Record<WorkItem["type"], string> = {
  call: "Call",
  email_doc: "Email / Doc",
  violation: "Violation",
  recurring: "Recurring",
  task: "Task",
};

function dueLabel(due: string | null): { text: string; overdue: boolean } {
  if (!due) return { text: "No due date", overdue: false };
  const d = new Date(due);
  const overdue = d.getTime() < Date.now();
  return {
    text: d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    overdue,
  };
}

export function WorkItemCard({
  item,
  associationName,
  assigneeName,
  isMine,
}: {
  item: WorkItem;
  associationName?: string;
  assigneeName?: string;
  isMine: boolean;
}) {
  const due = dueLabel(item.due_date);

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium leading-snug text-neutral-900">
          {item.title}
        </h3>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY_STYLES[item.priority]}`}
        >
          {item.priority}
        </span>
      </div>

      {item.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-neutral-500">
          {item.description}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-400">
        <span>{TYPE_LABELS[item.type]}</span>
        {associationName && (
          <>
            <span>·</span>
            <span>{associationName}</span>
          </>
        )}
        <span>·</span>
        <span className={due.overdue ? "font-medium text-red-600" : ""}>
          {due.text}
        </span>
        {assigneeName && (
          <>
            <span>·</span>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
              {assigneeName}
            </span>
          </>
        )}
      </div>

      {(item.metadata?.web_link || item.metadata?.draft_created) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          {item.metadata?.web_link && (
            <a
              href={item.metadata.web_link}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-600 hover:underline"
            >
              Open in Outlook ↗
            </a>
          )}
          {item.metadata?.draft_created && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-700">
              Reply drafted
            </span>
          )}
        </div>
      )}

      <form className="mt-3 flex flex-wrap gap-1.5">
        {!isMine && (
          <button
            formAction={updateWorkItem.bind(null, { id: item.id, claim: true })}
            className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50"
          >
            Claim
          </button>
        )}
        {item.status !== "in_progress" && item.status !== "done" && (
          <button
            formAction={updateWorkItem.bind(null, { id: item.id, status: "in_progress" })}
            className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50"
          >
            Start
          </button>
        )}
        {item.status !== "done" && (
          <button
            formAction={updateWorkItem.bind(null, { id: item.id, status: "done" })}
            className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white transition hover:bg-neutral-800"
          >
            Done
          </button>
        )}
        {item.status !== "escalated" && item.status !== "done" && (
          <button
            formAction={updateWorkItem.bind(null, { id: item.id, status: "escalated" })}
            className="rounded-md border border-amber-200 px-2 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-50"
          >
            Escalate
          </button>
        )}
      </form>
    </div>
  );
}
