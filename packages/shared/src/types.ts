import type {
  BlockReason,
  BlockStatus,
  BookingPaymentStatus,
  BookingSource,
  BookingStatusCode,
  Currency,
  Locale,
  MemberStatus,
  PaymentAdjustmentAction,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  PhotoMimeType,
  PricingRuleType,
  ProofMimeType,
} from './constants.ts';
import type { Role } from './roles.ts';

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Business {
  id: string;
  name: string;
  owner_name: string | null;
  phone: string | null;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessMember {
  id: string;
  business_id: string;
  user_id: string;
  role: Role;
  status: MemberStatus;
  invited_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessSettings {
  business_id: string;
  default_language: Locale;
  default_currency: Currency;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface UserPreferences {
  user_id: string;
  language: Locale;
  last_business_id: string | null;
  created_at: string;
  updated_at: string;
}

// --- properties (Phase 2) ---------------------------------------------------

/** One whole rentable building. Bookings (Phase 4) reserve the entire row. */
export interface Property {
  id: string;
  business_id: string;
  name: string;
  address: string | null;
  description: string | null;
  phone: string | null;
  map_location: string | null;
  latitude: number | null;
  longitude: number | null;
  /** `HH:MM:SS` from postgres `time`. */
  default_check_in_time: string;
  default_check_out_time: string;
  is_active: boolean;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyPhoto {
  id: string;
  business_id: string;
  property_id: string;
  storage_path: string;
  file_name: string | null;
  mime_type: PhotoMimeType;
  size_bytes: number | null;
  is_cover: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyPricing {
  id: string;
  business_id: string;
  property_id: string;
  rule_type: PricingRuleType;
  /** PostgREST serialises `numeric` as a JSON number (verified by db:smoke). */
  weekday_price: number;
  weekend_price: number;
  currency: Currency;
  created_at: string;
  updated_at: string;
}

export interface PropertyBlock {
  id: string;
  business_id: string;
  property_id: string;
  /** Half-open range `[starts_at, ends_at)`. */
  starts_at: string;
  ends_at: string;
  reason: BlockReason;
  note: string | null;
  status: BlockStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A property joined with the rows the list and detail screens always need. */
export interface PropertyWithDetails extends Property {
  pricing: PropertyPricing | null;
  photos: PropertyPhoto[];
}

/**
 * A guest of the business. Customers never sign in — there is no `auth.users`
 * row behind this — so `created_by` is the staff member who entered them.
 */
export interface Customer {
  id: string;
  business_id: string;
  full_name: string;
  /** Exactly as it was typed, for display and for calling back. */
  phone: string;
  /** E.164, produced by `normalizePhone`. The only column matching compares. */
  normalized_phone: string;
  phone_secondary: string | null;
  normalized_phone_secondary: string | null;
  email: string | null;
  facebook_name: string | null;
  facebook_url: string | null;
  telegram_username: string | null;
  preferred_language: Locale;
  address: string | null;
  note: string | null;
  /** Soft delete. Set only through `set_customer_archived()`. */
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Internal staff note. Never rendered anywhere a guest could see it. */
export interface CustomerNote {
  id: string;
  business_id: string;
  customer_id: string;
  body: string;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Outcome for one row of a CSV import, as returned by `import_customers`. */
export interface CustomerImportResult {
  index: number;
  status: 'imported' | 'duplicate' | 'invalid';
  customer_id: string | null;
  message: string | null;
}

// --- bookings (Phase 4) -----------------------------------------------------

/**
 * A per-business, user-editable booking status. `code` is the stable internal
 * category the system reasons about; `name` is only ever display text.
 */
export interface BookingStatus {
  id: string;
  business_id: string;
  name: string;
  code: BookingStatusCode;
  /** `#rrggbb`. */
  color: string;
  sort_order: number;
  /** One per code per business, seeded on creation. Cannot be deleted. */
  is_system: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** One stay of one whole property. Half-open `[check_in_at, check_out_at)`. */
export interface Booking {
  id: string;
  business_id: string;
  /** `BK-2026-000001`, unique per business. */
  booking_number: string;
  property_id: string;
  customer_id: string;
  status_id: string;
  check_in_at: string;
  check_out_at: string;
  currency: Currency;
  /** What the property's rates say. Never recalculated after the fact. */
  calculated_price: number;
  /** What is actually owed — equal to `calculated_price` unless overridden. */
  final_price: number;
  price_overridden: boolean;
  price_override_reason: string | null;
  /** Snapshot, only when the booking currency differs from the business default. */
  exchange_rate: number | null;
  source: BookingSource;
  note: string | null;
  internal_note: string | null;
  /** Set only while the status is `pending`; null otherwise. */
  pending_expires_at: string | null;
  /** An owner/manager decided to keep an expired pending booking alive. */
  pending_resolved_at: string | null;
  conflict_override: boolean;
  conflict_override_reason: string | null;
  conflict_override_by: string | null;
  conflict_override_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A booking joined with the rows every list, calendar and detail screen needs. */
export interface BookingWithDetails extends Booking {
  status: BookingStatus | null;
  property: Pick<Property, 'id' | 'name' | 'is_active' | 'archived_at'> | null;
  customer: Pick<Customer, 'id' | 'full_name' | 'phone' | 'normalized_phone'> | null;
}

/** Written by a trigger on every status change; never by a client. */
export interface BookingStatusHistory {
  id: string;
  business_id: string;
  booking_id: string;
  from_status_id: string | null;
  to_status_id: string;
  changed_by: string | null;
  changed_at: string;
}

// --- payments (Phase 5) -----------------------------------------------------

/**
 * One movement of money against one booking. Refunds are rows too, with a
 * positive `amount` and `payment_type = 'refund'`, so no column ever goes
 * negative and the original payment is never edited to make a refund fit.
 *
 * Rows are never deleted. `status` is how a payment stops counting.
 */
export interface Payment {
  id: string;
  business_id: string;
  booking_id: string;
  customer_id: string;
  /** `PM-2026-000001`, unique per business. */
  payment_number: string;
  amount: number;
  /** Copied from the booking, never taken from the client. */
  currency: Currency;
  /** The booking's snapshot rate, so a receipt reprints the same figures. */
  exchange_rate: number | null;
  method: PaymentMethod;
  payment_type: PaymentType;
  status: PaymentStatus;
  paid_at: string;
  /** Bank/ABA transaction id. Unique per business unless overridden. */
  reference: string | null;
  payer_name: string | null;
  note: string | null;
  duplicate_override: boolean;
  overpayment_override: boolean;
  override_reason: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A screenshot or PDF backing a payment. Insert-only: proof is evidence. */
export interface PaymentProof {
  id: string;
  business_id: string;
  payment_id: string;
  /** `businesses/{businessId}/payments/{paymentId}/{fileName}`. Never public. */
  storage_path: string;
  file_name: string;
  mime_type: ProofMimeType;
  size_bytes: number;
  /** SHA-256 of the bytes, when the client could compute one. Dedupe signal. */
  checksum: string | null;
  uploaded_by: string | null;
  created_at: string;
}

/** The audit trail. Written by the RPCs, never by a client. */
export interface PaymentAdjustment {
  id: string;
  business_id: string;
  payment_id: string;
  action: PaymentAdjustmentAction;
  reason: string;
  original_amount: number;
  /** Null for a void — nothing replaced the amount, it simply stopped counting. */
  corrected_amount: number | null;
  /** The refund row this adjustment created, for `action = 'refund'`. */
  refund_payment_id: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * What a receipt said at the moment it was issued. Everything printed comes
 * from `snapshot`; renaming the property next month must not change a receipt
 * a guest is already holding.
 */
export interface ReceiptSnapshot {
  business_name: string;
  business_phone: string | null;
  booking_number: string;
  customer_name: string;
  customer_phone: string | null;
  property_name: string;
  check_in_at: string;
  check_out_at: string;
  currency: Currency;
  booking_total: number;
  deposit_required: number;
  total_paid: number;
  refund_total: number;
  net_paid: number;
  balance: number;
  payment_status: BookingPaymentStatus;
  payment_number: string | null;
  payment_amount: number | null;
  payment_method: PaymentMethod | null;
  payment_reference: string | null;
  payment_at: string | null;
  issued_by_name: string;
  timezone: string;
}

export interface Receipt {
  id: string;
  business_id: string;
  booking_id: string;
  payment_id: string | null;
  /** `RC-2026-000001`, unique per business. */
  receipt_number: string;
  language: Locale;
  snapshot: ReceiptSnapshot;
  issued_by: string | null;
  issued_at: string;
}

/** A payment joined with the rows every list and detail screen needs. */
export interface PaymentWithDetails extends Payment {
  proofs: PaymentProof[];
  adjustments: PaymentAdjustment[];
  booking: Pick<Booking, 'id' | 'booking_number' | 'check_in_at' | 'check_out_at'> | null;
  customer: Pick<Customer, 'id' | 'full_name' | 'phone'> | null;
  property: Pick<Property, 'id' | 'name'> | null;
}

/**
 * What a booking owes, as returned by `booking_payment_summary()`. Computed
 * from the payment rows on every read — there is no balance column anywhere,
 * because a balance column is a number that can be wrong.
 */
export interface BookingPaymentSummary {
  booking_id: string;
  business_id: string;
  currency: Currency;
  booking_total: number;
  deposit_required: number;
  total_paid: number;
  refund_total: number;
  net_paid: number;
  balance: number;
  paid_percent: number;
  payment_status: BookingPaymentStatus;
}

/** One reason `payment_duplicates()` thinks this money may already be recorded. */
export interface PaymentDuplicate {
  kind: 'reference' | 'amount' | 'file';
  id: string;
  payment_number: string;
  amount: number;
  currency: Currency;
  paid_at: string;
  reference: string | null;
  status: PaymentStatus;
}

/** Shape returned by the `current_business_context` RPC. */
export interface BusinessContext {
  business_id: string;
  business_name: string;
  role: Role;
  default_currency: Currency;
  default_language: Locale;
  timezone: string;
  member_count: number;
}
