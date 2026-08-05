import { redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { CustomerForm } from '@/components/customers/CustomerForm';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';

export default async function NewCustomerPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  // The server action and the database check this again; this only avoids
  // showing a form that could never be submitted.
  if (!can(context.role, 'customers.manage')) redirect('/guests');

  const t = createTranslator(await getLocale());

  return (
    <>
      <PageHeader title={t('customer.new')} />
      <CustomerForm defaultLanguage={context.default_language} />
    </>
  );
}
