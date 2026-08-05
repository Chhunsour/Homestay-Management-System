import { redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { PropertyForm } from '@/components/properties/PropertyForm';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';

export default async function NewPropertyPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  // The server action and the database check this again; this only avoids
  // showing a form that could never be submitted.
  if (!can(context.role, 'properties.manage')) redirect('/properties');

  const t = createTranslator(await getLocale());

  return (
    <>
      <PageHeader title={t('property.new')} />
      <PropertyForm defaultCurrency={context.default_currency} />
    </>
  );
}
