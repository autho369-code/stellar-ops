export type WorkItem = {
  id: string;
  type: "call" | "email_doc" | "violation" | "recurring" | "task";
  title: string;
  description: string | null;
  source_channel: string | null;
  status: "open" | "in_progress" | "escalated" | "done";
  priority: "emergency" | "urgent" | "routine";
  owner_user_id: string | null;
  association_id: string | null;
  due_date: string | null;
  created_at: string;
};
