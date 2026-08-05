'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  LOCALE_STORAGE_KEY,
  createBusinessSchema,
  fieldErrors,
  updatePreferencesSchema,
} from '@homestay/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { failure, type ActionState } from '@/lib/actions/state';

const ONE_YEAR = 60 * 60 * 24 * 365;

export async function createBusinessAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createBusinessSchema.safeParse({
    name: formData.get('name'),
    ownerName: formData.get('ownerName'),
    phone: formData.get('phone'),
    language: formData.get('language'),
    currency: formData.get('currency'),
    timezone: formData.get('timezone'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return failure('error.unauthorized');

  // The RPC decides the role. Nothing role-shaped is sent from here.
  const { error } = await supabase.rpc('create_business', {
    p_name: parsed.data.name,
    p_owner_name: parsed.data.ownerName,
    p_phone: parsed.data.phone,
    p_language: parsed.data.language,
    p_currency: parsed.data.currency,
    p_timezone: parsed.data.timezone,
  });
  if (error) return failure('error.generic');

  const store = await cookies();
  store.set(LOCALE_STORAGE_KEY, parsed.data.language, {
    maxAge: ONE_YEAR,
    sameSite: 'lax',
    path: '/',
  });

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}

/**
 * Persists the language for signed-in users and mirrors it into a cookie so the
 * very first server render (including the auth screens) is already translated.
 */
export async function setLanguageAction(formData: FormData): Promise<void> {
  const parsed = updatePreferencesSchema.safeParse({ language: formData.get('language') });
  // An unknown language is only reachable by tampering; ignore it rather than
  // failing the page. The UI never offers anything but the two locales.
  if (!parsed.success) return;

  const store = await cookies();
  store.set(LOCALE_STORAGE_KEY, parsed.data.language, {
    maxAge: ONE_YEAR,
    sameSite: 'lax',
    path: '/',
  });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // RLS restricts this to the caller's own row; user_id is never sent.
    await supabase
      .from('user_preferences')
      .update({ language: parsed.data.language })
      .eq('user_id', user.id);
  }

  revalidatePath('/', 'layout');
}
