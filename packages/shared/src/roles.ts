/**
 * Central permission model.
 *
 * This matrix is mirrored by the `public.role_permissions` seed rows in
 * `supabase/migrations/*_security_functions.sql`. The database copy is the
 * enforcement point (RLS + RPC); this copy exists so the UI can hide actions a
 * user cannot perform. `src/roles.test.ts` fails if the two drift apart.
 */
export const ROLES = ['owner', 'manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'business.update',
  'business.delete',
  'business.settings.manage',
  'subscription.manage',
  'platform.settings.manage',
  'members.read',
  'members.invite',
  'members.role.update',
  'members.remove',
  'properties.read',
  'properties.manage',
  'properties.pricing.manage',
  'properties.photos.manage',
  'properties.blocks.manage',
  'properties.archive',
  // `customers.manage` covers read, create, edit and adding a note — the work
  // staff do all day. Everything below it is owner/manager only.
  'customers.manage',
  'customers.archive',
  'customers.notes.manage',
  'customers.import',
  'customers.export',
  // `bookings.manage` covers view, create and edit — including linking a
  // customer and adding notes. Everything below it is owner/manager only.
  'bookings.manage',
  'bookings.statuses.manage',
  'bookings.conflict.override',
  'bookings.price.override',
  'bookings.cancel',
  'bookings.restore',
  'bookings.pending.resolve',
  'payments.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: [
    'members.read',
    'members.invite',
    'members.remove',
    'properties.read',
    'properties.manage',
    'properties.pricing.manage',
    'properties.photos.manage',
    'properties.blocks.manage',
    'customers.manage',
    'customers.archive',
    'customers.notes.manage',
    'customers.import',
    'customers.export',
    'bookings.manage',
    'bookings.conflict.override',
    'bookings.price.override',
    'bookings.cancel',
    'bookings.pending.resolve',
    'payments.manage',
  ],
  // Staff see properties and their availability; they change nothing about them.
  // For customers they may search, create, correct contact details and add
  // notes — but not archive, edit someone else's note, import or bulk export.
  // For bookings they may view, create and edit — but never override a date
  // conflict or a price, customise statuses, or cancel and restore a booking.
  staff: ['properties.read', 'customers.manage', 'bookings.manage'],
};

/** Rank used for "you may not act on someone at or above your level" checks. */
export const ROLE_RANK: Record<Role, number> = { owner: 3, manager: 2, staff: 1 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Mirrors `public.can_manage_member()` in SQL: only owners change roles, and a
 * member may never act on their own row (no self-promotion).
 */
export function canManageMember(args: {
  actorRole: Role | null | undefined;
  actorUserId: string;
  targetRole: Role;
  targetUserId: string;
  action: 'role.update' | 'remove';
}): boolean {
  const { actorRole, actorUserId, targetRole, targetUserId, action } = args;
  if (!actorRole) return false;
  if (actorUserId === targetUserId) return false;
  if (action === 'role.update') return actorRole === 'owner';
  if (actorRole === 'owner') return true;
  // Managers may only remove people ranked below them (staff).
  return actorRole === 'manager' && ROLE_RANK[targetRole] < ROLE_RANK.manager;
}
