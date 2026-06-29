import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Uses the public anon key — all access is
// constrained by RLS (company_id = get_my_company_id()).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
