import type { BusinessContext, Role } from '@homestay/shared';
import { can, type Permission } from '@homestay/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * The business the current user should be looking at, resolved server-side by
 * `current_business_context()`. Returns null when the user has no business yet,
 * which is what routes the app to onboarding.
 *
 * Note: Supabase types are not generated in Phase 1 (that needs a live project),
 * so the RPC result is asserted here and nowhere else. See docs/SUPABASE_SETUP.md.
 */
export async function getBusinessContext(): Promise<BusinessContext | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('current_business_context');

  if (error) throw new Error(error.message);
  const rows = (data ?? []) as BusinessContext[];
  return rows[0] ?? null;
}

export interface MemberSummary {
  user_id: string;
  role: Role;
  full_name: string | null;
}

/** Active members, or null when the caller lacks `members.read`. */
export async function getActiveMembers(context: BusinessContext): Promise<MemberSummary[] | null> {
  if (!can(context.role, 'members.read')) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('business_members')
    .select('user_id, role, profiles(full_name)')
    .eq('business_id', context.business_id)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    // Untyped until Supabase types are generated; the embedded profile arrives
    // as an object for a to-one relation.
    const record = row as unknown as {
      user_id: string;
      role: Role;
      profiles?: { full_name: string | null } | null;
    };
    return {
      user_id: record.user_id,
      role: record.role,
      full_name: record.profiles?.full_name ?? null,
    };
  });
}

/** Server-side permission gate. Mirrors the database, never replaces it. */
export function requirePermission(context: BusinessContext, permission: Permission): void {
  if (!can(context.role, permission)) {
    throw new Error('error.unauthorized');
  }
}
