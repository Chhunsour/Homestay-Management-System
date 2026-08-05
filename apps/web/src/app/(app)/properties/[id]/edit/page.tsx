import { notFound, redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { PropertyForm } from '@/components/properties/PropertyForm';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getProperty } from '@/lib/properties';

export default async function EditPropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  if (!can(context.role, 'properties.manage')) redirect('/properties');

  const { id } = await params;
  const property = await getProperty(context, id);
  if (!property) notFound();

  const t = createTranslator(await getLocale());

  return (
    <>
      <PageHeader title={t('property.edit')} description={property.name} />
      <PropertyForm property={property} defaultCurrency={context.default_currency} />
    </>
  );
}
