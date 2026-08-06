import { redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { PageHeader } from '@/components/ui';
import { OcrScanFlow } from '@/components/payments/OcrScanFlow';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { listBookableProperties } from '@/lib/bookings';
import { listRecentProofs } from '@/lib/payments';

export default async function OcrScanPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  if (!can(context.role, 'payments.manage')) redirect('/payments');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const [recentProofs, properties] = await Promise.all([
    listRecentProofs(context),
    listBookableProperties(context),
  ]);

  return (
    <>
      <PageHeader title={t('ocr.title')} description={t('ocr.subtitle')} />
      <OcrScanFlow
        businessId={context.business_id}
        timezone={context.timezone}
        recentProofs={recentProofs}
        properties={properties}
        canOverridePrice={can(context.role, 'bookings.price.override')}
        canOverrideConflict={can(context.role, 'bookings.conflict.override')}
        canOverridePayment={can(context.role, 'payments.override')}
      />
    </>
  );
}
