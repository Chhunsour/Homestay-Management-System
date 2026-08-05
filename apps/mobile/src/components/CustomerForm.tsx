import { useState } from 'react';
import { router } from 'expo-router';
import { LOCALES, customerSchema, fieldErrors } from '@homestay/shared';
import type { Customer, Locale, TranslationKey } from '@homestay/shared';
import { Banner, Button, Field } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { useSession } from '@/lib/session';
import {
  createCustomer,
  findCustomerByPhone,
  updateCustomer,
  type DuplicateMatch,
} from '@/lib/customers';

const LANGUAGE_LABELS: Record<Locale, TranslationKey> = {
  en: 'common.english',
  km: 'common.khmer',
};

/**
 * One form for create and edit. Only a name and a phone are required —
 * everything else is what staff fill in later, once the guest has actually
 * stayed. A form that demands more than that gets filled with junk.
 */
export function CustomerForm({ customer }: { customer?: Customer }) {
  const { t, business } = useSession();
  const editing = Boolean(customer);

  const [fullName, setFullName] = useState(customer?.full_name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [phoneSecondary, setPhoneSecondary] = useState(customer?.phone_secondary ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [facebookName, setFacebookName] = useState(customer?.facebook_name ?? '');
  const [facebookUrl, setFacebookUrl] = useState(customer?.facebook_url ?? '');
  const [telegramUsername, setTelegramUsername] = useState(customer?.telegram_username ?? '');
  const [address, setAddress] = useState(customer?.address ?? '');
  const [note, setNote] = useState(customer?.note ?? '');
  const [preferredLanguage, setPreferredLanguage] = useState<Locale>(
    customer?.preferred_language ?? business?.default_language ?? 'en',
  );

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldError = (key: string): string | undefined => {
    const value = errors[key];
    return value ? t(value as TranslationKey) : undefined;
  };

  async function submit(): Promise<void> {
    if (!business) return;
    setErrors({});
    setErrorKey(null);
    setDuplicate(null);
    setBusy(true);

    try {
      const parsed = customerSchema.safeParse({
        fullName,
        phone,
        phoneSecondary,
        email,
        facebookName,
        facebookUrl,
        telegramUsername,
        preferredLanguage,
        address,
        note,
      });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      // ponytail: an archived match blocks the save too — restoring that record
      // keeps the guest's history in one place. Add a force flag only if a real
      // business turns out to need two records for one number.
      const existing = await findCustomerByPhone(
        business.business_id,
        parsed.data.phone,
        customer?.id,
      );
      if (existing) return setDuplicate(existing);

      if (customer) {
        const failed = await updateCustomer(business.business_id, customer.id, parsed.data);
        if (failed) return setErrorKey(failed);
        return router.back();
      }

      const { id, errorKey: failed } = await createCustomer(business.business_id, parsed.data);
      if (failed) return setErrorKey(failed);
      router.replace(id ? `/customer/${id}` : '/(tabs)/customers');
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      {/* The duplicate warning is the one error that offers a way out. */}
      {duplicate ? (
        <>
          <Banner tone="error">
            {`${t('customer.duplicate.title')}\n${t('customer.duplicate.body', {
              name: duplicate.full_name,
              phone: duplicate.phone,
            })}`}
          </Banner>
          <Button
            label={t('customer.duplicate.open')}
            variant="secondary"
            onPress={() => router.replace(`/customer/${duplicate.id}`)}
          />
        </>
      ) : null}

      <Field
        label={t('customer.field.fullName')}
        value={fullName}
        onChangeText={setFullName}
        error={fieldError('fullName')}
        maxLength={160}
      />
      <Field
        label={t('customer.field.phone')}
        value={phone}
        onChangeText={setPhone}
        error={fieldError('phone')}
        hint={t('customer.field.phone.hint')}
        keyboardType="phone-pad"
        autoCapitalize="none"
        maxLength={32}
        placeholder="012 345 678"
      />
      <Field
        label={t('customer.field.phoneSecondary')}
        value={phoneSecondary}
        onChangeText={setPhoneSecondary}
        error={fieldError('phoneSecondary')}
        keyboardType="phone-pad"
        autoCapitalize="none"
        maxLength={32}
      />
      <Field
        label={t('customer.field.email')}
        value={email}
        onChangeText={setEmail}
        error={fieldError('email')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label={t('customer.field.facebookName')}
        value={facebookName}
        onChangeText={setFacebookName}
        error={fieldError('facebookName')}
        maxLength={160}
      />
      <Field
        label={t('customer.field.facebookUrl')}
        value={facebookUrl}
        onChangeText={setFacebookUrl}
        error={fieldError('facebookUrl')}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={500}
      />
      <Field
        label={t('customer.field.telegram')}
        value={telegramUsername}
        onChangeText={setTelegramUsername}
        error={fieldError('telegramUsername')}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="@username"
        maxLength={64}
      />
      <ChoiceGroup
        label={t('customer.field.language')}
        options={LOCALES}
        value={preferredLanguage}
        onChange={setPreferredLanguage}
        renderLabel={(option) => t(LANGUAGE_LABELS[option])}
        error={fieldError('preferredLanguage')}
      />
      <Field
        label={t('customer.field.address')}
        value={address}
        onChangeText={setAddress}
        error={fieldError('address')}
        maxLength={500}
      />
      <Field
        label={t('customer.field.note')}
        value={note}
        onChangeText={setNote}
        error={fieldError('note')}
        multiline
        numberOfLines={4}
        maxLength={2000}
      />

      <Button
        label={t(editing ? 'common.save' : 'customer.create.submit')}
        loading={busy}
        onPress={() => void submit()}
      />
      <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
    </>
  );
}
