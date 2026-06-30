"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type WorkItemStatus = "open" | "in_progress" | "escalated" | "done";

// Single server action behind every queue button. Updates status and/or owner.
// Args are bound per-button via .bind() rather than read from the submitter's
// name/value: Next.js rewrites a submit button's `name` attribute to its own
// internal action-id token when `formAction` points at a server action, so a
// button's own `name`/`value` never reaches the action's FormData.
export async function updateWorkItem(
  args: { id: string; status?: WorkItemStatus; claim?: boolean },
  _formData: FormData,
) {
  const { id, status, claim } = args;
  if (!id) return;

  const supabase = await createClient();
  const patch: Record<string, unknown> = {};

  if (status) {
    patch.status = status;
    patch.completed_at = status === "done" ? new Date().toISOString() : null;
    if (status !== "escalated") patch.escalated_at = null;
  }

  if (claim) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    patch.owner_user_id = user?.id ?? null;
    if (patch.status === undefined) patch.status = "in_progress";
  }

  if (Object.keys(patch).length === 0) return;

  // RLS guarantees the row belongs to the caller's company.
  await supabase.from("work_items").update(patch).eq("id", id);
  revalidatePath("/ops");
}
