/**
 * Phone normalisation, Cambodia first.
 *
 * A customer is identified by phone, so matching must not depend on how the
 * number was typed. `012 345 678`, `012-345-678`, `(012) 345 678`,
 * `+855 12 345 678`, `85512345678` and `0085512345678` are all the same person.
 *
 * The number the user typed is stored verbatim for display; the value returned
 * here is stored alongside it and is the only thing duplicate detection and
 * phone search ever compare. The same function runs in both apps and inside the
 * CSV importer, so a row imported from a spreadsheet matches a customer typed
 * in by hand.
 */

export const CAMBODIA_CALLING_CODE = '855';

/** A Cambodian national number is 8 or 9 digits once the leading 0 is gone. */
function isCambodianNational(digits: string): boolean {
  const national = digits.replace(/^0+/, '');
  return national.length >= 8 && national.length <= 9;
}

function cambodian(digits: string): string | null {
  const national = digits.replace(/^0+/, '');
  return national ? `+${CAMBODIA_CALLING_CODE}${national}` : null;
}

/**
 * Returns E.164 (`+85512345678`) or `null` when the input holds no digits at
 * all. Shape is *not* validated here — `isNormalizedPhone` does that — because
 * the importer needs to show the user what a bad row normalised to.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  // Spaces, dashes, dots, parentheses and slashes are formatting, never data.
  const cleaned = input.replace(/[^\d+]/g, '');
  let digits = cleaned.replace(/\+/g, '');
  if (!digits) return null;

  // `+` and the `00` trunk prefix both mean "a country code follows".
  let international = cleaned.startsWith('+');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!digits) return null;

  if (international) {
    return digits.startsWith(CAMBODIA_CALLING_CODE)
      ? cambodian(digits.slice(3))
      : // A genuine foreign number. Kept as dialled: this app is used in a
        // border province and guests arrive with Thai and Vietnamese numbers.
        `+${digits}`;
  }

  // No prefix at all. `85512345678` pasted from a chat app is still Cambodian;
  // `0855…` is not, so the length of what follows has to make sense first.
  if (digits.startsWith(CAMBODIA_CALLING_CODE) && isCambodianNational(digits.slice(3))) {
    return cambodian(digits.slice(3));
  }
  return cambodian(digits);
}

/** Same E.164 shape `phoneSchema` accepts. Guards writes and CSV rows. */
export function isNormalizedPhone(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

/** Convenience for callers that only care whether a typed number is usable. */
export function isValidPhone(input: string | null | undefined): boolean {
  return isNormalizedPhone(normalizePhone(input));
}
