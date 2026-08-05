'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  PHOTO_MAX_BYTES,
  PROPERTY_PHOTO_BUCKET,
  PHOTO_EXTENSIONS,
  createPropertySchema,
  fieldErrors,
  isPhotoMimeType,
  propertyBlockSchema,
  propertyDetailsSchema,
  propertyPricingSchema,
  propertyPhotoPath,
  zonedTimeToUtc,
} from '@homestay/shared';
import type { PropertyPhoto } from '@homestay/shared';
import { getBusinessContext, requirePermission } from '@/lib/business';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { failure, success, type ActionState } from '@/lib/actions/state';

/**
 * Server Actions for properties.
 *
 * Each one re-reads the caller's business context from the database rather than
 * trusting a business id from the form. The RLS policies would reject a forged
 * one anyway; this makes the rejection a clean error instead of an empty result.
 */

function readDetails(formData: FormData) {
  return {
    name: formData.get('name'),
    address: formData.get('address'),
    description: formData.get('description'),
    phone: formData.get('phone'),
    mapLocation: formData.get('mapLocation'),
    latitude: formData.get('latitude'),
    longitude: formData.get('longitude'),
    checkInTime: formData.get('checkInTime'),
    checkOutTime: formData.get('checkOutTime'),
    isActive: formData.get('isActive'),
  };
}

function readPricing(formData: FormData) {
  return {
    weekdayPrice: formData.get('weekdayPrice'),
    weekendPrice: formData.get('weekendPrice'),
    currency: formData.get('currency'),
  };
}

/** 23505 is the partial unique index on (business_id, lower(name)). */
function writeError(error: { code?: string }): ActionState {
  if (error.code === '23505')
    return failure('property.error.duplicateName', { name: 'property.error.duplicateName' });
  return failure('error.generic');
}

export async function createPropertyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'properties.manage');

  const parsed = createPropertySchema.safeParse({
    ...readDetails(formData),
    ...readPricing(formData),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  // One RPC so a property never exists without its base rate.
  const { data, error } = await supabase.rpc('create_property', {
    p_business_id: context.business_id,
    p_name: parsed.data.name,
    p_weekday_price: parsed.data.weekdayPrice,
    p_weekend_price: parsed.data.weekendPrice,
    p_currency: parsed.data.currency,
    p_address: parsed.data.address,
    p_description: parsed.data.description,
    p_phone: parsed.data.phone,
    p_map_location: parsed.data.mapLocation,
    p_latitude: parsed.data.latitude,
    p_longitude: parsed.data.longitude,
    p_check_in_time: parsed.data.checkInTime,
    p_check_out_time: parsed.data.checkOutTime,
    p_is_active: parsed.data.isActive,
  });
  if (error) return writeError(error);

  const created = data as { id: string } | null;
  revalidatePath('/properties');
  redirect(created ? `/properties/${created.id}` : '/properties');
}

export async function updatePropertyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'properties.manage');

  const propertyId = String(formData.get('propertyId') ?? '');
  const parsed = propertyDetailsSchema.safeParse(readDetails(formData));
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('properties')
    .update({
      name: parsed.data.name,
      address: parsed.data.address,
      description: parsed.data.description,
      phone: parsed.data.phone,
      map_location: parsed.data.mapLocation,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      default_check_in_time: parsed.data.checkInTime,
      default_check_out_time: parsed.data.checkOutTime,
      is_active: parsed.data.isActive,
    })
    .eq('id', propertyId)
    .eq('business_id', context.business_id);
  if (error) return writeError(error);

  revalidatePath('/properties');
  revalidatePath(`/properties/${propertyId}`);
  return success('property.updated');
}

export async function updatePricingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'properties.pricing.manage');

  const propertyId = String(formData.get('propertyId') ?? '');
  const parsed = propertyPricingSchema.safeParse(readPricing(formData));
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  // create_property always writes the base row, so this is an update, never an
  // upsert — and an upsert would need a client-supplied business_id.
  const { error } = await supabase
    .from('property_pricing')
    .update({
      weekday_price: parsed.data.weekdayPrice,
      weekend_price: parsed.data.weekendPrice,
      currency: parsed.data.currency,
    })
    .eq('property_id', propertyId)
    .eq('business_id', context.business_id)
    .eq('rule_type', 'base');
  if (error) return writeError(error);

  revalidatePath(`/properties/${propertyId}`);
  return success('pricing.updated');
}

/** The active/inactive switch on the list and detail screens. */
export async function setPropertyActiveAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'properties.manage');

  const propertyId = String(formData.get('propertyId') ?? '');
  const isActive = formData.get('isActive') === 'true';

  const supabase = await createSupabaseServerClient();
  await supabase
    .from('properties')
    .update({ is_active: isActive })
    .eq('id', propertyId)
    .eq('business_id', context.business_id);

  revalidatePath('/properties');
  revalidatePath(`/properties/${propertyId}`);
}

/** "Delete" in the UI. Owners only; the row survives for booking history. */
export async function archivePropertyAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'properties.archive');

  const supabase = await createSupabaseServerClient();
  await supabase.rpc('set_property_archived', {
    p_property_id: String(formData.get('propertyId') ?? ''),
    p_archived: true,
  });

  revalidatePath('/properties');
  redirect('/properties');
}

// --- availability blocks ----------------------------------------------------

export async function createBlockAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'properties.blocks.manage');

  const parsed = propertyBlockSchema.safeParse({
    propertyId: formData.get('propertyId'),
    startsAt: formData.get('startsAt'),
    endsAt: formData.get('endsAt'),
    reason: formData.get('reason'),
    note: formData.get('note'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The form collects wall-clock time; the column is an instant.
  const { error } = await supabase.from('property_blocks').insert({
    business_id: context.business_id,
    property_id: parsed.data.propertyId,
    starts_at: zonedTimeToUtc(parsed.data.startsAt, context.timezone).toISOString(),
    ends_at: zonedTimeToUtc(parsed.data.endsAt, context.timezone).toISOString(),
    reason: parsed.data.reason,
    note: parsed.data.note,
    created_by: user?.id ?? null,
  });
  if (error) return failure('error.generic');

  revalidatePath(`/properties/${parsed.data.propertyId}`);
  return success('block.created');
}

export async function cancelBlockAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'properties.blocks.manage');

  const propertyId = String(formData.get('propertyId') ?? '');
  const supabase = await createSupabaseServerClient();
  // Cancelled, not deleted: the reason stays answerable later.
  await supabase
    .from('property_blocks')
    .update({ status: 'cancelled' })
    .eq('id', String(formData.get('blockId') ?? ''))
    .eq('business_id', context.business_id);

  revalidatePath(`/properties/${propertyId}`);
}

// --- photos -----------------------------------------------------------------

export async function uploadPhotoAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'properties.photos.manage');

  const propertyId = String(formData.get('propertyId') ?? '');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return failure('error.generic');
  // Storage enforces both of these too; failing here gives a translated message
  // instead of a raw storage error.
  if (!isPhotoMimeType(file.type)) return failure('photo.error.type');
  if (file.size > PHOTO_MAX_BYTES) return failure('photo.error.size');

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const storagePath = propertyPhotoPath({
    businessId: context.business_id,
    propertyId,
    // Never the user's file name: it decides the object key, and the key is
    // what the storage policies parse.
    fileName: `${crypto.randomUUID()}.${PHOTO_EXTENSIONS[file.type]}`,
  });

  const uploaded = await supabase.storage
    .from(PROPERTY_PHOTO_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploaded.error) return failure('photo.error.upload');

  const existing = await supabase
    .from('property_photos')
    .select('id')
    .eq('property_id', propertyId)
    .eq('business_id', context.business_id)
    .limit(1);

  const { error } = await supabase.from('property_photos').insert({
    business_id: context.business_id,
    property_id: propertyId,
    storage_path: storagePath,
    file_name: file.name.slice(0, 255),
    mime_type: file.type,
    size_bytes: file.size,
    // First photo becomes the cover, so a property is never coverless.
    is_cover: (existing.data ?? []).length === 0,
    created_by: user?.id ?? null,
  });
  if (error) {
    // Do not leave an orphan object behind if the metadata row is rejected.
    await supabase.storage.from(PROPERTY_PHOTO_BUCKET).remove([storagePath]);
    return failure('error.generic');
  }

  revalidatePath('/properties');
  revalidatePath(`/properties/${propertyId}`);
  return success('photo.uploaded');
}

export async function deletePhotoAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'properties.photos.manage');

  const photoId = String(formData.get('photoId') ?? '');
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from('property_photos')
    .select('id, property_id, storage_path, is_cover')
    .eq('id', photoId)
    .eq('business_id', context.business_id)
    .maybeSingle();
  if (!data) return;
  const photo = data as Pick<PropertyPhoto, 'id' | 'property_id' | 'storage_path' | 'is_cover'>;

  const removed = await supabase.storage.from(PROPERTY_PHOTO_BUCKET).remove([photo.storage_path]);
  // Keep the row if the object survived, so the two never drift apart.
  if (removed.error) return;

  await supabase.from('property_photos').delete().eq('id', photoId);

  if (photo.is_cover) {
    const { data: next } = await supabase
      .from('property_photos')
      .select('id')
      .eq('property_id', photo.property_id)
      .eq('business_id', context.business_id)
      .order('sort_order', { ascending: true })
      .limit(1);
    const promoted = (next ?? [])[0] as { id: string } | undefined;
    if (promoted) await supabase.rpc('set_property_cover_photo', { p_photo_id: promoted.id });
  }

  revalidatePath('/properties');
  revalidatePath(`/properties/${photo.property_id}`);
}

export async function setCoverPhotoAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'properties.photos.manage');

  const supabase = await createSupabaseServerClient();
  // An RPC because clearing the old cover and setting the new one must not
  // collide with the one-cover-per-property unique index halfway through.
  await supabase.rpc('set_property_cover_photo', {
    p_photo_id: String(formData.get('photoId') ?? ''),
  });

  revalidatePath('/properties');
  revalidatePath(`/properties/${String(formData.get('propertyId') ?? '')}`);
}
