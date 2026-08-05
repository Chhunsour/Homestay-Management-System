import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  PHOTO_MAX_BYTES,
  can,
  createTranslator,
  formatDate,
  formatMoney,
  toTimeInput,
} from '@homestay/shared';
import { BlockManager } from '@/components/properties/BlockManager';
import { PhotoManager, type PhotoView } from '@/components/properties/PhotoManager';
import { PricingForm } from '@/components/properties/PricingForm';
import { PropertyStatusActions } from '@/components/properties/PropertyStatusActions';
import { Badge, DataRow, PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getProperty, getPropertyBlocks, signedPhotoUrls } from '@/lib/properties';

export default async function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const { id } = await params;
  const property = await getProperty(context, id);
  if (!property) notFound();

  const locale = await getLocale();
  const t = createTranslator(locale);
  const blocks = await getPropertyBlocks(context, id);
  const urls = await signedPhotoUrls(property.photos.map((photo) => photo.storage_path));
  const photos: PhotoView[] = property.photos.map((photo) => ({
    ...photo,
    url: urls[photo.storage_path] ?? null,
  }));

  const canManage = can(context.role, 'properties.manage');
  const canPrice = can(context.role, 'properties.pricing.manage');
  const canPhotos = can(context.role, 'properties.photos.manage');
  const canBlocks = can(context.role, 'properties.blocks.manage');

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={property.name} description={property.address ?? undefined} />
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <Link href={`/properties/${property.id}/edit`} className={buttonStyles('secondary')}>
              {t('common.edit')}
            </Link>
          ) : null}
          <PropertyStatusActions
            propertyId={property.id}
            isActive={property.is_active}
            canManage={canManage}
            canArchive={can(context.role, 'properties.archive')}
          />
        </div>
      </div>

      {canManage ? null : (
        <p className="mb-5 rounded-sm border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {t('property.readOnly')}
        </p>
      )}

      <div className="space-y-6">
        <Panel>
          <div className="flex items-center justify-between gap-2 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              {t('property.section.details')}
            </h2>
            <Badge>
              {property.is_active ? t('property.status.active') : t('property.status.inactive')}
            </Badge>
          </div>
          <dl className="border-t border-slate-100">
            <DataRow
              label={t('property.field.address')}
              value={property.address || t('common.notSet')}
            />
            <DataRow
              label={t('property.field.description')}
              value={property.description || t('common.notSet')}
            />
            <DataRow
              label={t('property.field.phone')}
              value={property.phone || t('common.notSet')}
            />
            <DataRow
              label={t('property.field.mapLocation')}
              value={property.map_location || t('common.notSet')}
            />
            <DataRow
              label={t('property.field.latitude')}
              value={property.latitude ?? t('common.notSet')}
            />
            <DataRow
              label={t('property.field.longitude')}
              value={property.longitude ?? t('common.notSet')}
            />
            <DataRow
              label={t('property.field.checkIn')}
              value={toTimeInput(property.default_check_in_time)}
            />
            <DataRow
              label={t('property.field.checkOut')}
              value={toTimeInput(property.default_check_out_time)}
            />
            <DataRow
              label={t('property.field.created')}
              value={formatDate(locale, property.created_at, context.timezone)}
            />
          </dl>
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('pricing.title')}</h2>
            <p className="mt-1 text-sm text-slate-600">{t('pricing.subtitle')}</p>
          </div>
          {canPrice ? (
            <PricingForm
              propertyId={property.id}
              pricing={property.pricing}
              defaultCurrency={context.default_currency}
            />
          ) : (
            <dl className="border-t border-slate-100">
              <DataRow
                label={t('pricing.weekday')}
                value={
                  property.pricing
                    ? formatMoney(locale, property.pricing.weekday_price, property.pricing.currency)
                    : t('pricing.missing')
                }
              />
              <DataRow
                label={t('pricing.weekend')}
                value={
                  property.pricing
                    ? formatMoney(locale, property.pricing.weekend_price, property.pricing.currency)
                    : t('pricing.missing')
                }
              />
            </dl>
          )}
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('photo.title')}</h2>
          </div>
          <PhotoManager
            propertyId={property.id}
            photos={photos}
            canManage={canPhotos}
            maxSizeLabel={`${Math.round(PHOTO_MAX_BYTES / 1024 / 1024)} MB`}
          />
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('block.title')}</h2>
            <p className="mt-1 text-sm text-slate-600">{t('block.subtitle')}</p>
          </div>
          <BlockManager
            propertyId={property.id}
            blocks={blocks}
            timezone={context.timezone}
            canManage={canBlocks}
          />
        </Panel>
      </div>
    </>
  );
}
