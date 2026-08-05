import { notFound, redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { CustomerForm } from '@/components/customers/CustomerForm';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getCustomer } from '@/lib/customers';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  if (!can(context.role, 'customers.manage')) redirect('/guests');

  const { id } = await params;
  const customer = await getCustomer(context, id);
  if (!customer) notFound();
  // Archived rows are read-only: the UPDATE policy rejects them anyway.
  if (customer.archived_at) redirect(`/guests/${customer.id}`);

  const t = createTranslator(await getLocale());

  return (
    <>
      <PageHeader title={t('customer.edit')} description={customer.full_name} />
      <CustomerForm customer={customer} defaultLanguage={context.default_language} />
    </>
  );
}
