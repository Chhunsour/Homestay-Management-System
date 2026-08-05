import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ROLES, ROLE_PERMISSIONS, can, canManageMember, type Role } from './roles.ts';

// Every migration, because later phases add rows to role_permissions too.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/**
 * The database is the enforcement point; this matrix only drives the UI. If the
 * two disagree the UI will offer actions the server rejects (or hide ones it
 * allows), so fail loudly.
 */
test('TS permission matrix matches the role_permissions seed in SQL', () => {
  const sql = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(MIGRATIONS_DIR + file, 'utf8'))
    .join('\n');

  // Only look inside seed statements, so `role in ('owner', 'manager')`
  // elsewhere in the files cannot be mistaken for a seeded tuple.
  const seeds = [
    ...sql.matchAll(/insert\s+into\s+public\.role_permissions[^;]*?values([^;]*);/gis),
  ];
  assert.ok(seeds.length > 0, 'could not find the role_permissions seed statement');

  const fromSql = new Map<Role, Set<string>>(ROLES.map((role) => [role, new Set<string>()]));
  const tuple = /\('(owner|manager|staff)',\s*'([a-z.]+)'\)/g;
  for (const seed of seeds) {
    for (const match of seed[1]!.matchAll(tuple)) {
      fromSql.get(match[1] as Role)?.add(match[2] as string);
    }
  }

  const seeded = [...fromSql.values()].reduce((total, set) => total + set.size, 0);
  assert.ok(seeded > 0, 'no role_permissions rows found in the migration');

  for (const role of ROLES) {
    assert.deepEqual(
      [...ROLE_PERMISSIONS[role]].sort(),
      [...(fromSql.get(role) ?? [])].sort(),
      `permissions for "${role}" drifted between roles.ts and the migration`,
    );
  }
});

test('can() reflects the role hierarchy', () => {
  assert.equal(can('owner', 'business.delete'), true);
  assert.equal(can('manager', 'business.delete'), false);
  assert.equal(can('manager', 'bookings.manage'), true);
  assert.equal(can('staff', 'bookings.manage'), true);
  assert.equal(can('staff', 'members.read'), false);
  // Phase 2: staff read properties but change nothing about them.
  assert.equal(can('staff', 'properties.read'), true);
  assert.equal(can('staff', 'properties.manage'), false);
  assert.equal(can('staff', 'properties.pricing.manage'), false);
  assert.equal(can('staff', 'properties.blocks.manage'), false);
  assert.equal(can('manager', 'properties.pricing.manage'), true);
  assert.equal(can('manager', 'properties.archive'), false);
  assert.equal(can('owner', 'properties.archive'), true);
  assert.equal(can('staff', 'subscription.manage'), false);
  assert.equal(can(null, 'bookings.manage'), false);
});

test('canManageMember blocks self-service and privilege escalation', () => {
  const actor = 'user-a';
  const target = 'user-b';

  // Nobody edits their own membership, not even an owner.
  assert.equal(
    canManageMember({
      actorRole: 'owner',
      actorUserId: actor,
      targetRole: 'owner',
      targetUserId: actor,
      action: 'role.update',
    }),
    false,
  );

  // Only owners change roles.
  assert.equal(
    canManageMember({
      actorRole: 'manager',
      actorUserId: actor,
      targetRole: 'staff',
      targetUserId: target,
      action: 'role.update',
    }),
    false,
  );
  assert.equal(
    canManageMember({
      actorRole: 'owner',
      actorUserId: actor,
      targetRole: 'staff',
      targetUserId: target,
      action: 'role.update',
    }),
    true,
  );

  // Managers remove staff only.
  assert.equal(
    canManageMember({
      actorRole: 'manager',
      actorUserId: actor,
      targetRole: 'staff',
      targetUserId: target,
      action: 'remove',
    }),
    true,
  );
  assert.equal(
    canManageMember({
      actorRole: 'manager',
      actorUserId: actor,
      targetRole: 'manager',
      targetUserId: target,
      action: 'remove',
    }),
    false,
  );
  assert.equal(
    canManageMember({
      actorRole: 'staff',
      actorUserId: actor,
      targetRole: 'staff',
      targetUserId: target,
      action: 'remove',
    }),
    false,
  );
});
