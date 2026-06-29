"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type WorkItemStatus = "open" | "in_progress" | "escalated" | "done";

// Single server action behind every queue button. Updates status and/or owner.
export async function updateWorkItem(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const status = formData.get("status");
  const claim = formData.get("claim"); // "me" to assign to the current user

  const supabase = await createClient();
  const patch: Record<string, unknown> = {};

  if (typeof status === "string" && status) {
    patch.status = status as WorkItemStatus;
    patch.completed_at = status === "done" ? new Date().toISOString() : null;
    if (status !== "escalated") patch.escalated_at = null;
  }

  if (claim === "me") {
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
