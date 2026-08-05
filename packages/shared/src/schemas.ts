import { z } from 'zod';
import {
  BLOCK_REASONS,
  BOOKING_SOURCES,
  BOOKING_STATUS_CODES,
  CURRENCIES,
  LOCALES,
  TIMEZONE_OPTIONS,
} from './constants.ts';
import { isValidPhone } from './phone.ts';
import { ROLES } from './roles.ts';

/**
 * Every message is an i18n key, not display text. Screens render
 * `t(issue.message)` so validation is translated like everything else.
 */
const requiredString = (max = 200) =>
  z.string().trim().min(1, 'validation.required').max(max, 'validation.tooLong');

/** E.164, e.g. +85512345678. Supabase phone OTP requires this format. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'validation.phone');

// Normalise first, then validate, so " Foo@Bar.com " is accepted.
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('validation.email'));

export const passwordSchema = z
  .string()
  .min(8, 'validation.password.min')
  .max(72, 'validation.tooLong');

export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'validation.code');

export const signInWithPasswordSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'validation.required'),
});
export type SignInWithPasswordInput = z.infer<typeof signInWithPasswordSchema>;

export const signUpSchema = z
  .object({
    fullName: requiredString(120),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'validation.password.match',
  });
export type SignUpInput = z.infer<typeof signUpSchema>;

export const phoneSignInSchema = z.object({ phone: phoneSchema });
export type PhoneSignInInput = z.infer<typeof phoneSignInSchema>;

export const verifyOtpSchema = z.object({ token: otpSchema });
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'validation.password.match',
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const createBusinessSchema = z.object({
  name: requiredString(120).pipe(z.string().min(2, 'validation.tooShort')),
  ownerName: requiredString(120),
  phone: phoneSchema,
  language: z.enum(LOCALES),
  currency: z.enum(CURRENCIES),
  timezone: requiredString(64),
});
export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

export const timezoneOptionSchema = z.enum(TIMEZONE_OPTIONS);

export const updateMemberRoleSchema = z.object({
  businessId: z.uuid('validation.required'),
  userId: z.uuid('validation.required'),
  role: z.enum(ROLES),
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const updatePreferencesSchema = z.object({
  language: z.enum(LOCALES),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

// --- properties (Phase 2) ---------------------------------------------------
//
// Both apps submit plain strings (FormData on the web, controlled inputs on
// mobile), so these schemas coerce rather than assuming typed input.

/** Blank optional field -> null, so the column is NULL and not an empty string. */
const optionalString = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'validation.tooLong')
    .optional()
    .transform((value) => (value ? value : null));

const optionalCoordinate = (bound: number) =>
  z
    .union([
      z.literal(''),
      z.coerce.number().gte(-bound, 'validation.range').lte(bound, 'validation.range'),
    ])
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value));

/** `HH:MM` from `<input type="time">`; postgres widens it to `HH:MM:SS`. */
const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time');

/** `YYYY-MM-DDTHH:MM` wall-clock, interpreted in the business time zone. */
const localDateTimeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'validation.dateTime');

/** Checkboxes post `'on'` or nothing; mobile posts a real boolean. */
const checkboxSchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === 'on' || value === 'true');

const priceSchema = z.coerce
  .number('validation.price')
  .gte(0, 'validation.price')
  .lte(9_999_999_999, 'validation.tooLong');

export const propertyDetailsSchema = z.object({
  name: requiredString(120).pipe(z.string().min(2, 'validation.tooShort')),
  address: optionalString(500),
  description: optionalString(4000),
  phone: z
    .union([z.literal(''), phoneSchema])
    .optional()
    .transform((value) => (value ? value : null)),
  mapLocation: optionalString(500),
  latitude: optionalCoordinate(90),
  longitude: optionalCoordinate(180),
  checkInTime: timeSchema,
  checkOutTime: timeSchema,
  isActive: checkboxSchema,
});
export type PropertyDetailsInput = z.infer<typeof propertyDetailsSchema>;

export const propertyPricingSchema = z.object({
  weekdayPrice: priceSchema,
  weekendPrice: priceSchema,
  currency: z.enum(CURRENCIES),
});
export type PropertyPricingInput = z.infer<typeof propertyPricingSchema>;

/** Create takes both at once: the RPC writes the property and its base rate. */
export const createPropertySchema = propertyDetailsSchema.extend(propertyPricingSchema.shape);
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

export const propertyBlockSchema = z
  .object({
    propertyId: z.uuid('validation.required'),
    startsAt: localDateTimeSchema,
    endsAt: localDateTimeSchema,
    reason: z.enum(BLOCK_REASONS),
    note: optionalString(1000),
  })
  // ISO-ordered strings compare correctly, so no Date parsing needed here.
  // The same rule exists as a CHECK constraint; this one just names the field.
  .refine((value) => value.endsAt > value.startsAt, {
    path: ['endsAt'],
    message: 'validation.range.end',
  });
export type PropertyBlockInput = z.infer<typeof propertyBlockSchema>;

// --- customers (Phase 3) ----------------------------------------------------
//
// Only a name and a phone are required: staff take bookings over Facebook and
// Telegram with a phone number and nothing else, and a form that demands more
// than that gets filled with junk.

/** Accepts anything a person would type; stores E.164 for matching. */
const customerPhoneSchema = z
  .string()
  .trim()
  .min(1, 'validation.required')
  .max(32, 'validation.tooLong')
  .refine((value) => isValidPhone(value), 'validation.phone');

const optionalCustomerPhoneSchema = z
  .union([z.literal(''), customerPhoneSchema])
  .optional()
  .transform((value) => (value ? value : null));

const optionalEmailSchema = z
  .union([z.literal(''), emailSchema])
  .optional()
  .transform((value) => (value ? value : null));

/** `@dara`, `dara` and a t.me link all mean the same account. */
const telegramSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => value?.replace(/^(?:https?:\/\/)?(?:t\.me\/|@)/i, '').trim() ?? '')
  .refine((value) => value === '' || /^[A-Za-z0-9_]{3,32}$/.test(value), 'validation.telegram')
  .transform((value) => (value ? value : null));

export const customerSchema = z.object({
  fullName: requiredString(160).pipe(z.string().min(2, 'validation.tooShort')),
  phone: customerPhoneSchema,
  phoneSecondary: optionalCustomerPhoneSchema,
  email: optionalEmailSchema,
  facebookName: optionalString(160),
  facebookUrl: optionalString(500),
  telegramUsername: telegramSchema,
  preferredLanguage: z.enum(LOCALES),
  address: optionalString(500),
  note: optionalString(2000),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const customerNoteSchema = z.object({
  customerId: z.uuid('validation.required'),
  body: requiredString(2000).pipe(z.string().min(2, 'validation.tooShort')),
});
export type CustomerNoteInput = z.infer<typeof customerNoteSchema>;

/**
 * One CSV row. Deliberately looser than `customerSchema`: an import shows the
 * user which rows failed and why, rather than rejecting the whole file, so the
 * optional fields silently drop instead of erroring.
 */
export const customerImportRowSchema = z.object({
  full_name: requiredString(160).pipe(z.string().min(2, 'validation.tooShort')),
  phone: customerPhoneSchema,
  email: optionalEmailSchema,
  facebook_name: optionalString(160),
  telegram_username: telegramSchema,
  address: optionalString(500),
  note: optionalString(2000),
});
export type CustomerImportRowInput = z.infer<typeof customerImportRowSchema>;

// --- bookings (Phase 4) -----------------------------------------------------
//
// The booking form is the one both apps submit, including the quick form used
// while a guest is still on the phone: property, customer, check-in, check-out.
// Everything else is optional.

const optionalUuid = z
  .union([z.literal(''), z.uuid('validation.required')])
  .optional()
  .transform((value) => (value ? value : null));

const optionalPriceSchema = z
  .union([z.literal(''), priceSchema])
  .optional()
  .transform((value) => (value === '' || value === undefined ? null : value));

export const bookingSchema = z
  .object({
    propertyId: z.uuid('validation.required'),
    customerId: optionalUuid,
    /** Filled instead of `customerId` when a new guest is typed into the form. */
    newCustomerName: optionalString(160),
    newCustomerPhone: optionalCustomerPhoneSchema,
    checkInAt: localDateTimeSchema,
    checkOutAt: localDateTimeSchema,
    statusId: optionalUuid,
    source: z.enum(BOOKING_SOURCES),
    note: optionalString(2000),
    internalNote: optionalString(2000),
    /** Null means "use the calculated price". */
    finalPrice: optionalPriceSchema,
    priceOverrideReason: optionalString(300),
    conflictOverride: checkboxSchema,
    conflictOverrideReason: optionalString(300),
  })
  // Same rule as the CHECK constraint; this one names the field for the form.
  .refine((value) => value.checkOutAt > value.checkInAt, {
    path: ['checkOutAt'],
    message: 'validation.range.end',
  })
  .refine((value) => !!value.customerId || (!!value.newCustomerName && !!value.newCustomerPhone), {
    path: ['customerId'],
    message: 'validation.required',
  })
  // A price nobody has to justify is a price nobody can audit.
  .refine((value) => value.finalPrice === null || (value.priceOverrideReason ?? '').length >= 3, {
    path: ['priceOverrideReason'],
    message: 'validation.required',
  })
  .refine((value) => !value.conflictOverride || (value.conflictOverrideReason ?? '').length >= 3, {
    path: ['conflictOverrideReason'],
    message: 'validation.required',
  });
export type BookingInput = z.infer<typeof bookingSchema>;

export const bookingStatusSchema = z.object({
  name: requiredString(40).pipe(z.string().min(2, 'validation.tooShort')),
  code: z.enum(BOOKING_STATUS_CODES),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'validation.color'),
  sortOrder: z.coerce.number('validation.range').int('validation.range').gte(0).lte(999),
  isActive: checkboxSchema,
});
export type BookingStatusInput = z.infer<typeof bookingStatusSchema>;

/** Owner/manager decision on a pending booking whose hold has lapsed. */
export const pendingResolutionSchema = z.object({
  bookingId: z.uuid('validation.required'),
  action: z.enum(['keep', 'release']),
});
export type PendingResolutionInput = z.infer<typeof pendingResolutionSchema>;

/** Collapses a ZodError into `{ field: i18nKey }` for form rendering. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    out[key] ??= issue.message;
  }
  return out;
}
