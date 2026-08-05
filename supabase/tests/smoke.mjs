// =============================================================================
// End-to-end smoke test against a REAL Supabase stack (GoTrue + PostgREST).
//
//   npm run db:smoke
//
// The SQL suite (rls_isolation.sql) proves the policy matrix by setting JWT
// claims directly. This proves the wiring around it: real signup, real signup
// trigger, real access token, real PostgREST — and that RLS still holds when
// the request arrives over HTTP instead of psql.
//
// Creates users, so it refuses to run against anything but a local stack.
// =============================================================================
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
const anon = process.env.SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!anon || !service) {
  console.error('Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (npx supabase status).');
  process.exit(1);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error(`Refusing to create users against a non-local stack: ${url}`);
  process.exit(1);
}

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? '✔' : '✘'} ${label}`);
  if (!ok) failures++;
}

async function api(path, { token = anon, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * Confirmed user + a real access token. Admin-created rather than
 * signup + click-the-email, which needs Mailpit in the loop; GoTrue issues the
 * same token either way.
 */
async function makeUser(email, fullName) {
  const password = 'Sup3r-secret-passw0rd';
  const created = await api('/auth/v1/admin/users', {
    token: service,
    method: 'POST',
    body: { email, password, email_confirm: true, user_metadata: { full_name: fullName } },
  });
  if (created.status !== 200)
    throw new Error(`admin create ${email}: ${JSON.stringify(created.body)}`);

  const signedIn = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  if (signedIn.status !== 200)
    throw new Error(`sign in ${email}: ${JSON.stringify(signedIn.body)}`);

  return { id: created.body.id, token: signedIn.body.access_token };
}

// Unique per run so repeat runs never collide.
const stamp = process.hrtime.bigint().toString(36);
const alice = await makeUser(`alice.${stamp}@example.com`, 'Alice Owner');
const bella = await makeUser(`bella.${stamp}@example.com`, 'Bella Owner');

check(Boolean(alice.token && bella.token), 'real password grant returns an access token');

// --- phone OTP ---------------------------------------------------------------
// Uses the [auth.sms.test_otp] number from config.toml, so no SMS is sent.
// This regressed silently once already: GoTrue disables phone login entirely
// unless an SMS provider is enabled, and the failure is a 400 at request time.
const TEST_PHONE = '+85512000000';
const otpSent = await api('/auth/v1/otp', { method: 'POST', body: { phone: TEST_PHONE } });
check(otpSent.status === 200, 'phone OTP request is accepted (an SMS provider is configured)');

const otpVerified = await api('/auth/v1/verify', {
  method: 'POST',
  body: { type: 'sms', phone: TEST_PHONE, token: '123456' },
});
check(Boolean(otpVerified.body?.access_token), 'phone OTP verification returns a session');
if (otpVerified.body?.user?.id) {
  await api(`/auth/v1/admin/users/${otpVerified.body.user.id}`, {
    token: service,
    method: 'DELETE',
  });
}

// --- the signup trigger ran ------------------------------------------------
const profile = await api(`/rest/v1/profiles?select=id,full_name`, { token: alice.token });
check(
  profile.status === 200 && profile.body.length === 1 && profile.body[0].id === alice.id,
  'handle_new_user created exactly one profile, visible only to its owner',
);
check(
  profile.body?.[0]?.full_name === 'Alice Owner',
  'profile picked up full_name from user metadata',
);

const prefs = await api('/rest/v1/user_preferences?select=user_id,language', {
  token: alice.token,
});
check(prefs.status === 200 && prefs.body.length === 1, 'user_preferences row was provisioned');

// --- create a business through the RPC, as the app does --------------------
async function createBusiness(user, name) {
  const res = await api('/rest/v1/rpc/create_business', {
    token: user.token,
    method: 'POST',
    // p_owner_name is written onto the caller's profile, so keep it distinct
    // per user — the team-panel check below reads it back.
    body: {
      p_name: name,
      p_owner_name: `${name} Owner`,
      p_phone: '+85512000000',
      p_language: 'km',
    },
  });
  if (res.status !== 200) throw new Error(`create_business ${name}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const alpha = await createBusiness(alice, `ALPHA ${stamp}`);
const beta = await createBusiness(bella, `BETA ${stamp}`);
check(alpha.id !== beta.id, 'two independent businesses were created over HTTP');

// --- tenant isolation, over the wire ---------------------------------------
const aliceSees = await api('/rest/v1/businesses?select=id,name', { token: alice.token });
check(
  aliceSees.status === 200 && aliceSees.body.length === 1 && aliceSees.body[0].id === alpha.id,
  'alice sees her own business and nothing else',
);

// Asking for BETA by id explicitly: a client-supplied id must not widen access.
const aliceProbe = await api(`/rest/v1/businesses?id=eq.${beta.id}&select=id`, {
  token: alice.token,
});
check(
  aliceProbe.status === 200 && aliceProbe.body.length === 0,
  'naming another tenant’s business id returns nothing',
);

const aliceMembers = await api('/rest/v1/business_members?select=business_id', {
  token: alice.token,
});
check(
  aliceMembers.body.every((m) => m.business_id === alpha.id),
  'membership rows never cross the tenant boundary',
);

// The Settings team panel embeds profiles through the member row. That needs a
// real foreign key between business_members and profiles, which lives in
// PostgREST's schema cache — invisible to the SQL suite, 500 in the browser.
const team = await api(
  `/rest/v1/business_members?select=user_id,role,profiles(full_name)&business_id=eq.${alpha.id}`,
  { token: alice.token },
);
check(
  team.status === 200 && team.body?.[0]?.profiles?.full_name === `${alpha.name} Owner`,
  'members query can embed profiles (FK is visible to PostgREST)',
);

const context = await api('/rest/v1/rpc/current_business_context', {
  token: alice.token,
  method: 'POST',
  body: {},
});
check(
  context.body?.[0]?.business_id === alpha.id && context.body[0].role === 'owner',
  'current_business_context resolves to the caller’s business as owner',
);

// --- writes the client must not be able to make ----------------------------
const selfPromote = await api('/rest/v1/rpc/set_member_role', {
  token: alice.token,
  method: 'POST',
  body: { p_business_id: alpha.id, p_user_id: alice.id, p_role: 'owner' },
});
check(selfPromote.status >= 400, 'owner cannot call set_member_role on themselves');

const crossTenant = await api('/rest/v1/rpc/soft_delete_business', {
  token: alice.token,
  method: 'POST',
  body: { p_business_id: beta.id },
});
check(crossTenant.status >= 400, 'alice cannot soft-delete another tenant’s business');

const directInsert = await api('/rest/v1/business_members', {
  token: alice.token,
  method: 'POST',
  body: { business_id: beta.id, user_id: alice.id, role: 'owner' },
});
check(directInsert.status >= 400, 'membership cannot be inserted directly, only through an RPC');

// --- properties, over the wire ----------------------------------------------
async function createProperty(user, businessId, name) {
  const res = await api('/rest/v1/rpc/create_property', {
    token: user.token,
    method: 'POST',
    body: {
      p_business_id: businessId,
      p_name: name,
      p_weekday_price: 45,
      p_weekend_price: 60,
      p_currency: 'USD',
    },
  });
  return res;
}

const created = await createProperty(alice, alpha.id, `Riverside ${stamp}`);
check(created.status === 200 && Boolean(created.body?.id), 'create_property works over PostgREST');
const property = created.body;

// The property screens read pricing and photos as embedded resources. Those
// hang off a composite FK, which PostgREST has to have in its schema cache —
// invisible to the SQL suite, a 400 in the browser.
const embedded = await api(
  `/rest/v1/properties?select=*,property_pricing(*),property_photos(*)&id=eq.${property.id}`,
  { token: alice.token },
);
// Asserted as a JSON number on purpose: PropertyPricing types the column that
// way, and PostgREST switching to strings would break formatting silently.
check(
  embedded.status === 200 && embedded.body?.[0]?.property_pricing?.[0]?.weekday_price === 45,
  'properties query can embed pricing and photos (composite FK is visible to PostgREST)',
);

const bellaProbe = await api(`/rest/v1/properties?id=eq.${property.id}&select=id`, {
  token: bella.token,
});
check(
  bellaProbe.status === 200 && bellaProbe.body.length === 0,
  'naming another tenant’s property id returns nothing',
);

const bellaCreate = await createProperty(bella, alpha.id, `Hijack ${stamp}`);
check(bellaCreate.status >= 400, 'a forged business id cannot create a property in another tenant');

// --- storage: private bucket, tenant-isolated keys ---------------------------
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const objectPath = `businesses/${alpha.id}/properties/${property.id}/cover.png`;

async function storage(path, { token, method = 'GET', body, contentType } = {}) {
  const res = await fetch(`${url}/storage/v1/${path}`, {
    method,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
  });
  return { status: res.status, res };
}

const upload = await storage(`object/property-photos/${objectPath}`, {
  token: alice.token,
  method: 'POST',
  body: PIXEL,
  contentType: 'image/png',
});
check(upload.status === 200, 'owner can upload into their own tenant prefix');

const foreignUpload = await storage(
  `object/property-photos/businesses/${alpha.id}/properties/${property.id}/stolen.png`,
  { token: bella.token, method: 'POST', body: PIXEL, contentType: 'image/png' },
);
check(foreignUpload.status >= 400, 'another tenant cannot upload into this prefix');

const foreignRead = await storage(`object/property-photos/${objectPath}`, { token: bella.token });
check(foreignRead.status >= 400, 'another tenant cannot download the object');

const publicRead = await fetch(`${url}/storage/v1/object/public/property-photos/${objectPath}`);
check(publicRead.status >= 400, 'the bucket is private: no unauthenticated public read');

const signed = await storage(`object/sign/property-photos/${objectPath}`, {
  token: alice.token,
  method: 'POST',
  body: JSON.stringify({ expiresIn: 600 }),
  contentType: 'application/json',
});
const signedUrl = signed.status === 200 ? (await signed.res.json()).signedURL : null;
check(Boolean(signedUrl), 'owner can mint a signed URL');
if (signedUrl) {
  const fetched = await fetch(`${url}/storage/v1${signedUrl}`);
  check(fetched.status === 200, 'the signed URL serves the object without a session');
}

// The metadata row has to describe an object inside its own prefix.
const badMeta = await api('/rest/v1/property_photos', {
  token: alice.token,
  method: 'POST',
  body: {
    business_id: alpha.id,
    property_id: property.id,
    storage_path: `businesses/${beta.id}/properties/${property.id}/cover.png`,
    mime_type: 'image/png',
  },
});
check(badMeta.status >= 400, 'a photo row cannot point at another tenant’s storage path');

const meta = await api('/rest/v1/property_photos', {
  token: alice.token,
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: {
    business_id: alpha.id,
    property_id: property.id,
    storage_path: objectPath,
    mime_type: 'image/png',
    is_cover: true,
  },
});
check(meta.status === 201, 'photo metadata insert is accepted for its own prefix');

const removed = await storage(`object/property-photos/${objectPath}`, {
  token: alice.token,
  method: 'DELETE',
});
check(removed.status === 200, 'owner can delete their own object');

// --- bookings, over the wire -------------------------------------------------
const customer = await api('/rest/v1/customers', {
  token: alice.token,
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: { business_id: alpha.id, full_name: 'សុខ ដារា', phone: '012 345 678' },
});
const customerId = customer.body?.[0]?.id;
check(Boolean(customerId), 'a customer to book for was created');

// A composite type comes back as an object; be tolerant either way.
const row = (res) => (Array.isArray(res.body) ? res.body[0] : res.body);

async function saveBooking(user, extra) {
  return api('/rest/v1/rpc/save_booking', {
    token: user.token,
    method: 'POST',
    body: {
      p_business_id: alpha.id,
      p_property_id: property.id,
      p_customer_id: customerId,
      ...extra,
    },
  });
}

const booked = await saveBooking(alice, {
  p_check_in: '2026-09-07T14:00:00+07:00',
  p_check_out: '2026-09-10T12:00:00+07:00',
  p_source: 'facebook',
});
check(booked.status === 200, 'save_booking works over PostgREST');
check(
  row(booked)?.booking_number === 'BK-2026-000001',
  'the first booking of the year is numbered BK-2026-000001',
);
// Priced at 45 x 3 weekday nights by the database, not by the caller.
check(Number(row(booked)?.calculated_price) === 135, 'the server priced the stay itself');

// The calendar and list read a booking with its status, property and customer
// embedded. Those hang off composite FKs, which PostgREST has to have in its
// schema cache — invisible to the SQL suite, a 400 in the browser.
const bookingEmbed = await api(
  `/rest/v1/bookings?select=*,booking_statuses(name,code,color),properties(name),customers(full_name,phone)&id=eq.${row(booked)?.id}`,
  { token: alice.token },
);
check(
  bookingEmbed.status === 200 &&
    bookingEmbed.body?.[0]?.booking_statuses?.code === 'pending' &&
    Boolean(bookingEmbed.body?.[0]?.properties?.name) &&
    Boolean(bookingEmbed.body?.[0]?.customers?.full_name),
  'bookings query can embed status, property and customer',
);

// Adjacent is fine: checking in the minute the last guest checks out.
const adjacent = await saveBooking(alice, {
  p_check_in: '2026-09-10T12:00:00+07:00',
  p_check_out: '2026-09-11T12:00:00+07:00',
});
check(adjacent.status === 200, 'a back-to-back booking is accepted');

// The one that matters: two requests for the same dates, at the same time, in
// separate transactions. The advisory lock inside save_booking is what makes
// this deterministic — without it both scans see free dates and both insert.
const raceBody = {
  p_check_in: '2026-10-01T14:00:00+07:00',
  p_check_out: '2026-10-03T12:00:00+07:00',
};
const race = await Promise.all([saveBooking(alice, raceBody), saveBooking(alice, raceBody)]);
check(
  race.filter((r) => r.status === 200).length === 1,
  'two simultaneous bookings of the same dates: exactly one wins',
);
check(
  race.some((r) => JSON.stringify(r.body ?? '').includes('booking_conflict')),
  'the losing request was refused with booking_conflict',
);

const bellaBooking = await api('/rest/v1/rpc/save_booking', {
  token: bella.token,
  method: 'POST',
  body: {
    p_business_id: alpha.id,
    p_property_id: property.id,
    p_customer_id: customerId,
    p_check_in: '2026-11-01T14:00:00+07:00',
    p_check_out: '2026-11-02T12:00:00+07:00',
  },
});
check(bellaBooking.status >= 400, 'a forged business id cannot create a booking in another tenant');

const bellaSees = await api('/rest/v1/bookings?select=id', { token: bella.token });
check(
  bellaSees.status === 200 && bellaSees.body.length === 0,
  'another tenant reads no bookings at all',
);

const directBooking = await api('/rest/v1/bookings', {
  token: alice.token,
  method: 'POST',
  body: {
    business_id: alpha.id,
    booking_number: 'BK-2026-999999',
    property_id: property.id,
    customer_id: customerId,
    status_id: bookingEmbed.body?.[0]?.status_id,
    check_in_at: '2026-09-08T14:00:00+07:00',
    check_out_at: '2026-09-09T12:00:00+07:00',
    currency: 'USD',
    calculated_price: 0,
    final_price: 0,
  },
});
check(directBooking.status >= 400, 'bookings cannot be inserted directly, only through the RPC');

// --- archive is the delete ---------------------------------------------------
const archived = await api('/rest/v1/rpc/set_property_archived', {
  token: alice.token,
  method: 'POST',
  body: { p_property_id: property.id, p_archived: true },
});
check(archived.status === 200, 'set_property_archived succeeds for the owner');

const afterArchive = await api(`/rest/v1/properties?id=eq.${property.id}&select=id`, {
  token: alice.token,
});
check(afterArchive.body?.length === 0, 'an archived property is no longer readable');

const hardDelete = await api(`/rest/v1/properties?id=eq.${property.id}`, {
  token: alice.token,
  method: 'DELETE',
});
check(hardDelete.status >= 400, 'properties cannot be hard-deleted over the API');

// --- anonymous ---------------------------------------------------------------
const anonRead = await api('/rest/v1/businesses?select=id');
check(
  anonRead.status >= 400 || (Array.isArray(anonRead.body) && anonRead.body.length === 0),
  'the anon key alone reads no tenant data',
);

// --- cleanup: drop the users, which cascades to everything they created -----
for (const user of [alice, bella]) {
  await api(`/auth/v1/admin/users/${user.id}`, { token: service, method: 'DELETE' });
}

console.log(failures === 0 ? '\nALL SUPABASE SMOKE TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
