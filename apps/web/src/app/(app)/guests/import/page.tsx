import { redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { ImportWizard } from '@/components/customers/ImportWizard';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';

export default async function ImportCustomersPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  // `import_customers` checks this again in SQL.
  if (!can(context.role, 'customers.import')) redirect('/guests');

  const t = createTranslator(await getLocale());

  return (
    <>
      <PageHeader title={t('customer.import.title')} description={t('customer.import.subtitle')} />
      <ImportWizard />
    </>
  );
}
