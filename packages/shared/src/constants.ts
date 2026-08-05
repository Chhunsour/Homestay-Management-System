export const LOCALES = ['en', 'km'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const CURRENCIES = ['USD', 'KHR'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'USD';

export const DEFAULT_TIMEZONE = 'Asia/Phnom_Penh';

/**
 * Curated shortlist for the onboarding picker. Any IANA zone is accepted by the
 * database; this list only drives the default UI options.
 */
export const TIMEZONE_OPTIONS = [
  'Asia/Phnom_Penh',
  'Asia/Bangkok',
  'Asia/Ho_Chi_Minh',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Jakarta',
  'Asia/Vientiane',
  'Asia/Yangon',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'UTC',
] as const;

export const MEMBER_STATUSES = ['active', 'suspended'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

// --- properties (Phase 2) ---------------------------------------------------

/** Mirrors the `public.block_reason` enum. */
export const BLOCK_REASONS = ['maintenance', 'owner_use', 'renovation', 'custom'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** Mirrors the `public.block_status` enum. Blocks are cancelled, never deleted. */
export const BLOCK_STATUSES = ['active', 'cancelled'] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

/** Mirrors the `public.pricing_rule_type` enum; seasonal rules land here later. */
export const PRICING_RULE_TYPES = ['base'] as const;
export type PricingRuleType = (typeof PRICING_RULE_TYPES)[number];

/**
 * Weekend = Friday, Saturday, Sunday, as JS `Date.getDay()` numbers.
 * Defined once here; `availability.ts` is the only consumer.
 */
export const WEEKEND_DAYS = [5, 6, 0] as const;

/** Private bucket holding property images. See docs/SUPABASE_SETUP.md. */
export const PROPERTY_PHOTO_BUCKET = 'property-photos';

/** Also enforced by the bucket itself and by a CHECK on property_photos. */
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number];
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export const PHOTO_EXTENSIONS: Record<PhotoMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isPhotoMimeType(value: string): value is PhotoMimeType {
  return (PHOTO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * The one place the storage key layout is written down. Both the
 * `property_photos` INSERT policy and the storage.objects policies parse this
 * shape, so it must not be assembled ad hoc at call sites.
 */
export function propertyPhotoPath(args: {
  businessId: string;
  propertyId: string;
  fileName: string;
}): string {
  return `businesses/${args.businessId}/properties/${args.propertyId}/${args.fileName}`;
}

// --- customers (Phase 3) ----------------------------------------------------

/** List filter only. Archived state is the `archived_at` column, not an enum. */
export const CUSTOMER_FILTERS = ['active', 'archived', 'all'] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];

export function isCustomerFilter(value: unknown): value is CustomerFilter {
  return typeof value === 'string' && (CUSTOMER_FILTERS as readonly string[]).includes(value);
}

/** Page size for the customer list on both apps. */
export const CUSTOMER_PAGE_SIZE = 25;

/** Rows a single CSV import may contain. Keeps one request bounded. */
export const CUSTOMER_IMPORT_MAX_ROWS = 500;

// --- bookings (Phase 4) -----------------------------------------------------

/**
 * Mirrors the `public.booking_status_code` enum. These are the *internal* codes
 * every system rule is written against. Display names are per-business rows in
 * `booking_statuses` and may be renamed, reordered or recoloured freely.
 */
export const BOOKING_STATUS_CODES = ['pending', 'confirmed', 'completed', 'cancelled'] as const;
export type BookingStatusCode = (typeof BOOKING_STATUS_CODES)[number];

/**
 * Codes that hold the dates. Cancelled releases them; an expired pending one
 * does **not** — see docs/PHASE_4_BOOKINGS.md.
 */
export const BLOCKING_STATUS_CODES = ['pending', 'confirmed', 'completed'] as const;

export function blocksDates(code: BookingStatusCode): boolean {
  return (BLOCKING_STATUS_CODES as readonly string[]).includes(code);
}

/** Seeded for every new business by `create_business()`. Same order, same colours. */
export const DEFAULT_BOOKING_STATUSES: ReadonlyArray<{
  code: BookingStatusCode;
  name: string;
  color: string;
  sortOrder: number;
}> = [
  { code: 'pending', name: 'Pending', color: '#b45309', sortOrder: 1 },
  { code: 'confirmed', name: 'Confirmed', color: '#0f766e', sortOrder: 2 },
  { code: 'completed', name: 'Completed', color: '#334155', sortOrder: 3 },
  { code: 'cancelled', name: 'Cancelled', color: '#b91c1c', sortOrder: 4 },
];

/** Where the enquiry came from. Text + CHECK in SQL, so adding one is a migration. */
export const BOOKING_SOURCES = [
  'facebook',
  'telegram',
  'phone',
  'walk_in',
  'website',
  'other',
] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

/** How long a pending booking holds the dates before it needs a human decision. */
export const PENDING_EXPIRY_MINUTES = 30;

/** List filters on both apps. `expired` = pending, past its hold, unreviewed. */
export const BOOKING_FILTERS = ['upcoming', 'today', 'expired', 'all'] as const;
export type BookingFilter = (typeof BOOKING_FILTERS)[number];

export function isBookingFilter(value: unknown): value is BookingFilter {
  return typeof value === 'string' && (BOOKING_FILTERS as readonly string[]).includes(value);
}

export const BOOKING_PAGE_SIZE = 25;

/** Colour picker for custom statuses; the column accepts any `#rrggbb`. */
export const STATUS_COLORS = [
  '#b45309',
  '#0f766e',
  '#334155',
  '#b91c1c',
  '#7c3aed',
  '#1d4ed8',
  '#047857',
  '#be185d',
] as const;

/** Cookie / storage key used to persist the chosen language before sign-in. */
export const LOCALE_STORAGE_KEY = 'homestay.locale';

/** Auth methods the apps can expose; enabled subset comes from env. */
export const AUTH_PROVIDERS = ['password', 'phone', 'google', 'apple'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export function parseAuthProviders(raw: string | undefined): AuthProvider[] {
  if (!raw) return ['password'];
  const wanted = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is AuthProvider =>
      (AUTH_PROVIDERS as readonly string[]).includes(value),
    );
  // Password is the only method that always works without dashboard setup.
  return wanted.length > 0 ? wanted : ['password'];
}
