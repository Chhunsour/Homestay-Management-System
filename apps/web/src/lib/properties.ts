import { PROPERTY_PHOTO_BUCKET } from '@homestay/shared';
import type {
  BusinessContext,
  Property,
  PropertyBlock,
  PropertyPhoto,
  PropertyPricing,
  PropertyWithDetails,
} from '@homestay/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Read helpers for the property screens.
 *
 * Every query is scoped by `business_id` as well as being behind RLS. The filter
 * is not the security boundary — the policies are — but it keeps an accidental
 * cross-tenant query from silently returning nothing and looking like a bug.
 */

export type PropertyFilter = 'all' | 'active' | 'inactive';

const SIGNED_URL_TTL = 60 * 10;

export async function listProperties(
  context: BusinessContext,
  options: { search?: string; filter?: PropertyFilter } = {},
): Promise<PropertyWithDetails[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('properties')
    .select('*, property_pricing(*), property_photos(*)')
    .eq('business_id', context.business_id)
    .order('name', { ascending: true });

  if (options.filter === 'active') query = query.eq('is_active', true);
  if (options.filter === 'inactive') query = query.eq('is_active', false);

  const search = options.search?.trim();
  if (search) {
    // `%` and `,` would otherwise break out of the or() filter expression.
    const safe = search.replace(/[%,()]/g, ' ');
    query = query.or(`name.ilike.%${safe}%,address.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map(toPropertyWithDetails);
}

export async function getProperty(
  context: BusinessContext,
  propertyId: string,
): Promise<PropertyWithDetails | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('properties')
    .select('*, property_pricing(*), property_photos(*)')
    .eq('business_id', context.business_id)
    .eq('id', propertyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? toPropertyWithDetails(data) : null;
}

export async function getPropertyBlocks(
  context: BusinessContext,
  propertyId: string,
): Promise<PropertyBlock[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('property_blocks')
    .select('*')
    .eq('business_id', context.business_id)
    .eq('property_id', propertyId)
    .order('starts_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as PropertyBlock[];
}

/**
 * The bucket is private, so images are only ever reachable through short-lived
 * signed URLs minted for a caller that storage RLS already let read the object.
 */
export async function signedPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(PROPERTY_PHOTO_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);

  // A missing thumbnail must not take the page down.
  if (error) return {};

  const out: Record<string, string> = {};
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
  }
  return out;
}

export function coverPhoto(property: PropertyWithDetails): PropertyPhoto | null {
  return property.photos.find((photo) => photo.is_cover) ?? property.photos[0] ?? null;
}

/** Supabase types are not generated yet (see docs/SUPABASE_SETUP.md). */
function toPropertyWithDetails(row: unknown): PropertyWithDetails {
  const record = row as Property & {
    property_pricing?: PropertyPricing[] | null;
    property_photos?: PropertyPhoto[] | null;
  };
  const { property_pricing, property_photos, ...property } = record;

  return {
    ...property,
    pricing: property_pricing?.find((rule) => rule.rule_type === 'base') ?? null,
    photos: [...(property_photos ?? [])].sort(
      (a, b) =>
        Number(b.is_cover) - Number(a.is_cover) ||
        a.sort_order - b.sort_order ||
        a.created_at.localeCompare(b.created_at),
    ),
  };
}
