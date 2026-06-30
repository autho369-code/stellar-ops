import { createClient } from "@/lib/supabase/server";

// Standard recurring obligations most associations need. The team deletes the
// rows that don't apply (e.g. no elevator) and fills in next_due_date.
const STANDARD = [
  { title: "Master insurance renewal", category: "insurance", every: 12, lead: 30, priority: "urgent" },
  { title: "Fire extinguisher inspection", category: "fire_safety", every: 12, lead: 21, priority: "urgent" },
  { title: "Fire alarm & sprinkler inspection", category: "fire_safety", every: 12, lead: 21, priority: "urgent" },
  { title: "Elevator inspection", category: "elevator", every: 12, lead: 21, priority: "urgent" },
  { title: "Boiler inspection", category: "mechanical", every: 12, lead: 21, priority: "routine" },
  { title: "Backflow / RPZ test", category: "plumbing", every: 12, lead: 21, priority: "routine" },
  { title: "Kitchen stack rodding", category: "plumbing", every: 3, lead: 14, priority: "routine" },
  { title: "Dryer vent cleaning", category: "maintenance", every: 12, lead: 21, priority: "routine" },
  { title: "Annual meeting & budget", category: "governance", every: 12, lead: 30, priority: "routine" },
];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { data: assocs } = await supabase.from("associations").select("name").order("name");

  const header = "association,title,category,interval_months,lead_time_days,priority,next_due_date";
  const lines = [header];
  for (const a of assocs ?? []) {
    for (const s of STANDARD) {
      lines.push(
        [a.name, s.title, s.category, s.every, s.lead, s.priority, ""].map(csvCell).join(","),
      );
    }
  }
  const csv = lines.join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="stellar-property-calendar-template.csv"',
    },
  });
}
