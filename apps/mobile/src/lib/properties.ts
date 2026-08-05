import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import {
  PHOTO_EXTENSIONS,
  PHOTO_MAX_BYTES,
  PROPERTY_PHOTO_BUCKET,
  isPhotoMimeType,
  propertyPhotoPath,
} from '@homestay/shared';
import type {
  PropertyBlock,
  PropertyPhoto,
  PropertyPricing,
  PropertyWithDetails,
  Property,
  TranslationKey,
} from '@homestay/shared';
import { supabase } from '@/lib/supabase';

/**
 * Property queries for the app. Every call is scoped by `business_id` on top of
 * RLS — the policies are the boundary, the filter just keeps a mistake loud.
 *
 * Supabase types are not generated yet (see docs/SUPABASE_SETUP.md), so rows are
 * asserted here and nowhere else.
 */

export type PropertyFilter = 'all' | 'active' | 'inactive';

const SIGNED_URL_TTL = 60 * 10;

const SELECT = '*, property_pricing(*), property_photos(*)';

export async function listProperties(
  businessId: string,
  options: { search?: string; filter?: PropertyFilter } = {},
): Promise<PropertyWithDetails[]> {
  let query = supabase
    .from('properties')
    .select(SELECT)
    .eq('business_id', businessId)
    .order('name', { ascending: true });

  if (options.filter === 'active') query = query.eq('is_active', true);
  if (options.filter === 'inactive') query = query.eq('is_active', false);

  const search = options.search?.trim();
  // `%` and `,` would otherwise break out of the or() filter expression.
  if (search) {
    const safe = search.replace(/[%,()]/g, ' ');
    query = query.or(`name.ilike.%${safe}%,address.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toDetails);
}

export async function getProperty(
  businessId: string,
  propertyId: string,
): Promise<PropertyWithDetails | null> {
  const { data, error } = await supabase
    .from('properties')
    .select(SELECT)
    .eq('business_id', businessId)
    .eq('id', propertyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? toDetails(data) : null;
}

export async function getBlocks(businessId: string, propertyId: string): Promise<PropertyBlock[]> {
  const { data, error } = await supabase
    .from('property_blocks')
    .select('*')
    .eq('business_id', businessId)
    .eq('property_id', propertyId)
    .order('starts_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as PropertyBlock[];
}

/** The bucket is private; images are only reachable through short-lived URLs. */
export async function signedPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};

  const { data, error } = await supabase.storage
    .from(PROPERTY_PHOTO_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);
  // A missing thumbnail must not take the screen down.
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

// --- writes -----------------------------------------------------------------

/** Null when the write succeeded, otherwise the message key to show. */
export type WriteResult = TranslationKey | null;

function writeError(error: { code?: string } | null): WriteResult {
  if (!error) return null;
  if (error.code === '23505') return 'property.error.duplicateName';
  return 'error.generic';
}

export interface PropertyInput {
  name: string;
  address: string | null;
  description: string | null;
  phone: string | null;
  mapLocation: string | null;
  latitude: number | null;
  longitude: number | null;
  checkInTime: string;
  checkOutTime: string;
  isActive: boolean;
}

export interface PricingInput {
  weekdayPrice: number;
  weekendPrice: number;
  currency: string;
}

export async function createProperty(
  businessId: string,
  input: PropertyInput & PricingInput,
): Promise<{ id: string | null; errorKey: WriteResult }> {
  // One RPC so a property never exists without its base rate.
  const { data, error } = await supabase.rpc('create_property', {
    p_business_id: businessId,
    p_name: input.name,
    p_weekday_price: input.weekdayPrice,
    p_weekend_price: input.weekendPrice,
    p_currency: input.currency,
    p_address: input.address,
    p_description: input.description,
    p_phone: input.phone,
    p_map_location: input.mapLocation,
    p_latitude: input.latitude,
    p_longitude: input.longitude,
    p_check_in_time: input.checkInTime,
    p_check_out_time: input.checkOutTime,
    p_is_active: input.isActive,
  });

  const errorKey = writeError(error);
  return { id: errorKey ? null : ((data as { id: string } | null)?.id ?? null), errorKey };
}

export async function updateProperty(
  businessId: string,
  propertyId: string,
  input: PropertyInput,
): Promise<WriteResult> {
  const { error } = await supabase
    .from('properties')
    .update({
      name: input.name,
      address: input.address,
      description: input.description,
      phone: input.phone,
      map_location: input.mapLocation,
      latitude: input.latitude,
      longitude: input.longitude,
      default_check_in_time: input.checkInTime,
      default_check_out_time: input.checkOutTime,
      is_active: input.isActive,
    })
    .eq('id', propertyId)
    .eq('business_id', businessId);

  return writeError(error);
}

export async function updatePricing(
  businessId: string,
  propertyId: string,
  input: PricingInput,
): Promise<WriteResult> {
  // create_property always writes the base row, so this is an update.
  const { error } = await supabase
    .from('property_pricing')
    .update({
      weekday_price: input.weekdayPrice,
      weekend_price: input.weekendPrice,
      currency: input.currency,
    })
    .eq('property_id', propertyId)
    .eq('business_id', businessId)
    .eq('rule_type', 'base');

  return writeError(error);
}

export async function setPropertyActive(
  businessId: string,
  propertyId: string,
  isActive: boolean,
): Promise<WriteResult> {
  const { error } = await supabase
    .from('properties')
    .update({ is_active: isActive })
    .eq('id', propertyId)
    .eq('business_id', businessId);

  return writeError(error);
}

/** "Delete" in the UI. The row survives so booking history stays answerable. */
export async function archiveProperty(propertyId: string): Promise<WriteResult> {
  const { error } = await supabase.rpc('set_property_archived', {
    p_property_id: propertyId,
    p_archived: true,
  });
  return writeError(error);
}

export async function createBlock(
  businessId: string,
  input: {
    propertyId: string;
    startsAt: string;
    endsAt: string;
    reason: string;
    note: string | null;
  },
): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('property_blocks').insert({
    business_id: businessId,
    property_id: input.propertyId,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    reason: input.reason,
    note: input.note,
    created_by: user?.id ?? null,
  });

  return writeError(error);
}

export async function cancelBlock(businessId: string, blockId: string): Promise<WriteResult> {
  // Cancelled, not deleted: the reason stays answerable later.
  const { error } = await supabase
    .from('property_blocks')
    .update({ status: 'cancelled' })
    .eq('id', blockId)
    .eq('business_id', businessId);

  return writeError(error);
}

// --- photos -----------------------------------------------------------------

export interface PickedPhoto {
  uri: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

export async function uploadPhoto(
  businessId: string,
  propertyId: string,
  photo: PickedPhoto,
): Promise<WriteResult> {
  const mimeType = photo.mimeType ?? '';
  // Storage enforces both of these too; failing here gives a translated message.
  if (!isPhotoMimeType(mimeType)) return 'photo.error.type';

  let bytes: Uint8Array;
  try {
    bytes = await new File(photo.uri).bytes();
  } catch {
    return 'photo.error.upload';
  }
  if (bytes.byteLength > PHOTO_MAX_BYTES) return 'photo.error.size';

  const storagePath = propertyPhotoPath({
    businessId,
    propertyId,
    // Never the picked file name: it decides the object key, and the key is
    // what the storage policies parse.
    fileName: `${randomUUID()}.${PHOTO_EXTENSIONS[mimeType]}`,
  });

  const uploaded = await supabase.storage
    .from(PROPERTY_PHOTO_BUCKET)
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
  if (uploaded.error) return 'photo.error.upload';

  const existing = await supabase
    .from('property_photos')
    .select('id')
    .eq('property_id', propertyId)
    .eq('business_id', businessId)
    .limit(1);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('property_photos').insert({
    business_id: businessId,
    property_id: propertyId,
    storage_path: storagePath,
    file_name: (photo.fileName ?? 'photo').slice(0, 255),
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    // First photo becomes the cover, so a property is never coverless.
    is_cover: (existing.data ?? []).length === 0,
    created_by: user?.id ?? null,
  });
  if (error) {
    // Do not leave an orphan object behind if the metadata row is rejected.
    await supabase.storage.from(PROPERTY_PHOTO_BUCKET).remove([storagePath]);
    return 'error.generic';
  }

  return null;
}

export async function deletePhoto(businessId: string, photoId: string): Promise<WriteResult> {
  const { data } = await supabase
    .from('property_photos')
    .select('id, property_id, storage_path, is_cover')
    .eq('id', photoId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (!data) return 'error.generic';

  const photo = data as Pick<PropertyPhoto, 'id' | 'property_id' | 'storage_path' | 'is_cover'>;

  const removed = await supabase.storage.from(PROPERTY_PHOTO_BUCKET).remove([photo.storage_path]);
  // Keep the row if the object survived, so the two never drift apart.
  if (removed.error) return 'error.generic';

  const { error } = await supabase.from('property_photos').delete().eq('id', photoId);
  if (error) return writeError(error);

  if (photo.is_cover) {
    const { data: next } = await supabase
      .from('property_photos')
      .select('id')
      .eq('property_id', photo.property_id)
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .limit(1);
    const promoted = (next ?? [])[0] as { id: string } | undefined;
    if (promoted) await setCoverPhoto(promoted.id);
  }

  return null;
}

export async function setCoverPhoto(photoId: string): Promise<WriteResult> {
  // An RPC because clearing the old cover and setting the new one must not
  // collide with the one-cover-per-property unique index halfway through.
  const { error } = await supabase.rpc('set_property_cover_photo', { p_photo_id: photoId });
  return writeError(error);
}

function toDetails(row: unknown): PropertyWithDetails {
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
