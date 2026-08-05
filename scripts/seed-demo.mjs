const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
const anon =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const service =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const DEMO_EMAIL = 'admin@homestay.com';
const DEMO_PASSWORD = 'Password123!';
const DEMO_NAME = 'Homestay Admin';
const DEMO_PHONE = '+85512000000';

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

async function seed() {
  console.log('Seeding demo user and business data...');

  // 1. Create or fetch demo user
  let userToken;
  let userId;

  // Check if user already exists by trying to sign in
  const signedIn = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });

  if (signedIn.status === 200) {
    console.log('Demo user already exists. Re-using session.');
    userToken = signedIn.body.access_token;
    userId = signedIn.body.user.id;
  } else {
    // Create new admin user
    const created = await api('/auth/v1/admin/users', {
      token: service,
      method: 'POST',
      body: {
        email: DEMO_EMAIL,
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: DEMO_NAME },
      },
    });

    if (created.status !== 200) {
      console.error('Failed to create admin user:', created.body);
      process.exit(1);
    }
    userId = created.body.id;

    // Login to get access token
    const loginRes = await api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    userToken = loginRes.body.access_token;
    console.log(`Created demo user: ${DEMO_EMAIL} (ID: ${userId})`);
  }

  // 2. Check if business exists for user
  const userBusinesses = await api('/rest/v1/businesses?select=id,name', { token: userToken });
  let businessId;

  if (userBusinesses.status === 200 && userBusinesses.body.length > 0) {
    businessId = userBusinesses.body[0].id;
    console.log(`Using existing business: ${userBusinesses.body[0].name} (${businessId})`);
  } else {
    // Create business via RPC
    const busRes = await api('/rest/v1/rpc/create_business', {
      token: userToken,
      method: 'POST',
      body: {
        p_name: 'Siem Reap Sanctuary Homestay',
        p_owner_name: DEMO_NAME,
        p_phone: DEMO_PHONE,
        p_language: 'en',
        p_currency: 'USD',
        p_timezone: 'Asia/Phnom_Penh',
      },
    });

    if (busRes.status !== 200) {
      console.error('Failed to create business:', busRes.body);
      process.exit(1);
    }
    businessId = busRes.body.id;
    console.log(`Created business: ${busRes.body.name} (${businessId})`);
  }

  // 3. Create sample properties if none exist
  const existingProps = await api(
    `/rest/v1/properties?business_id=eq.${businessId}&select=id,name`,
    { token: userToken },
  );
  let prop1Id, prop2Id;

  if (existingProps.status === 200 && existingProps.body.length > 0) {
    prop1Id = existingProps.body[0]?.id;
    prop2Id = existingProps.body[1]?.id;
    console.log(`Found ${existingProps.body.length} existing properties.`);
  } else {
    const p1 = await api('/rest/v1/rpc/create_property', {
      token: userToken,
      method: 'POST',
      body: {
        p_business_id: businessId,
        p_name: 'Angkor Garden Villa',
        p_weekday_price: 60,
        p_weekend_price: 85,
        p_currency: 'USD',
      },
    });
    prop1Id = p1.body?.id;
    console.log('Created Property 1: Angkor Garden Villa');

    const p2 = await api('/rest/v1/rpc/create_property', {
      token: userToken,
      method: 'POST',
      body: {
        p_business_id: businessId,
        p_name: 'Riverfront Bungalow',
        p_weekday_price: 40,
        p_weekend_price: 55,
        p_currency: 'USD',
      },
    });
    prop2Id = p2.body?.id;
    console.log('Created Property 2: Riverfront Bungalow');
  }

  // 4. Create sample customers if none exist
  const existingCustomers = await api(
    `/rest/v1/customers?business_id=eq.${businessId}&select=id,full_name`,
    { token: userToken },
  );
  let cust1Id, cust2Id;

  if (existingCustomers.status === 200 && existingCustomers.body.length > 0) {
    cust1Id = existingCustomers.body[0]?.id;
    cust2Id = existingCustomers.body[1]?.id;
    console.log(`Found ${existingCustomers.body.length} existing customers.`);
  } else {
    const c1 = await api('/rest/v1/customers', {
      token: userToken,
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: {
        business_id: businessId,
        full_name: 'Sok Dara',
        phone: '+85512345678',
        email: 'dara@example.com',
      },
    });
    cust1Id = c1.body?.[0]?.id;
    console.log('Created Customer 1: Sok Dara');

    const c2 = await api('/rest/v1/customers', {
      token: userToken,
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: {
        business_id: businessId,
        full_name: 'Chan Thavy',
        phone: '+85598765432',
        email: 'thavy@example.com',
      },
    });
    cust2Id = c2.body?.[0]?.id;
    console.log('Created Customer 2: Chan Thavy');
  }

  // 5. Create sample bookings if none exist
  const existingBookings = await api(`/rest/v1/bookings?business_id=eq.${businessId}&select=id`, {
    token: userToken,
  });
  if (existingBookings.status === 200 && existingBookings.body.length === 0 && prop1Id && cust1Id) {
    const b1 = await api('/rest/v1/rpc/save_booking', {
      token: userToken,
      method: 'POST',
      body: {
        p_business_id: businessId,
        p_property_id: prop1Id,
        p_customer_id: cust1Id,
        p_check_in: '2026-08-10T14:00:00+07:00',
        p_check_out: '2026-08-14T12:00:00+07:00',
        p_source: 'phone',
        p_note: 'Guest requested late check-in.',
      },
    });
    console.log(
      b1.status === 200
        ? `Created Booking 1 for Sok Dara at Angkor Garden Villa (${b1.body?.booking_number})`
        : `Booking 1 was refused: ${JSON.stringify(b1.body)}`,
    );

    if (prop2Id && cust2Id) {
      const b2 = await api('/rest/v1/rpc/save_booking', {
        token: userToken,
        method: 'POST',
        body: {
          p_business_id: businessId,
          p_property_id: prop2Id,
          p_customer_id: cust2Id,
          p_check_in: '2026-08-15T14:00:00+07:00',
          p_check_out: '2026-08-18T12:00:00+07:00',
          p_source: 'facebook',
          p_note: 'Family trip.',
        },
      });
      console.log(
        b2.status === 200
          ? `Created Booking 2 for Chan Thavy at Riverfront Bungalow (${b2.body?.booking_number})`
          : `Booking 2 was refused: ${JSON.stringify(b2.body)}`,
      );
    }
  }

  console.log('\n======================================================');
  console.log('SUCCESS! Demo Account Created & Seeded Successfully');
  console.log('======================================================');
  console.log(`Email:    ${DEMO_EMAIL}`);
  console.log(`Password: ${DEMO_PASSWORD}`);
  console.log(`Phone:    ${DEMO_PHONE} (OTP: 123456)`);
  console.log('======================================================');
}

seed().catch((err) => {
  console.error('Seed script error:', err);
  process.exit(1);
});
