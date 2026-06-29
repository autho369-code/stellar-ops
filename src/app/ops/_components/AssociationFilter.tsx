"use client";

import { useRouter, useSearchParams } from "next/navigation";

type Option = { id: string; name: string };

export function AssociationFilter({ associations }: { associations: Option[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const current = params.get("association") ?? "";

  return (
    <select
      value={current}
      onChange={(e) => {
        const value = e.target.value;
        const next = new URLSearchParams(params.toString());
        if (value) next.set("association", value);
        else next.delete("association");
        router.push(`/ops?${next.toString()}`);
      }}
      className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 outline-none transition focus:border-neutral-900"
    >
      <option value="">All associations</option>
      {associations.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
