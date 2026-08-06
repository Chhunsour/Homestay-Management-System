import { useCallback, useState } from 'react';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDateTime, formatMoney, statusLabel } from '@homestay/shared';
import type { BookingWithDetails, TranslationKey } from '@homestay/shared';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Row,
  Screen,
  StatusDot,
  Title,
  colors,
} from '@/components/ui';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { getHomeBookings, type HomeBookings } from '@/lib/bookings';
import { getHomeMoney, type HomeMoney } from '@/lib/payments';

/** Up to five rows of one list; the tabs hold the full versions. */
function BookingList({
  titleKey,
  bookings,
  field,
}: {
  titleKey: TranslationKey;
  bookings: BookingWithDetails[];
  field: 'check_in_at' | 'check_out_at';
}) {
  const { t, locale, business } = useSession();
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  return (
    <>
      <View style={styles.sectionHeading}>
        <Text style={styles.section}>{t(titleKey)}</Text>
        <Text style={styles.sectionCount}>{bookings.length}</Text>
      </View>
      {bookings.length === 0 ? (
        <Text style={styles.emptyLine}>{t('dashboard.none')}</Text>
      ) : (
        bookings.slice(0, 5).map((booking) => (
          <Link key={booking.id} href={`/booking/${booking.id}`} asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={booking.booking_number}
              style={({ pressed }) => [
                styles.card,
                { borderLeftColor: booking.status?.color ?? colors.brand },
                pressed ? styles.cardPressed : null,
              ]}
            >
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>{booking.property?.name}</Text>
                <StatusDot color={booking.status?.color ?? colors.muted} />
              </View>
              <Text style={styles.muted}>
                {`${booking.customer?.full_name ?? ''} · ${formatDateTime(
                  locale,
                  booking[field],
                  timezone,
                )}`}
              </Text>
              <Text style={styles.muted}>
                {booking.status ? statusLabel(booking.status, t) : ''}
              </Text>
            </Pressable>
          </Link>
        ))
      )}
    </>
  );
}

function Metric({
  label,
  value,
  featured = false,
}: {
  label: string;
  value: string | number;
  featured?: boolean;
}) {
  return (
    <View style={[styles.metric, featured ? styles.metricFeatured : null]}>
      <View style={[styles.metricMarker, featured ? styles.metricMarkerFeatured : null]} />
      <Text style={[styles.metricLabel, featured ? styles.metricLabelFeatured : null]}>
        {label}
      </Text>
      <Text style={[styles.metricValue, featured ? styles.metricValueFeatured : null]}>
        {value}
      </Text>
    </View>
  );
}

export default function HomeScreen() {
  const { t, locale, user, business, signOut } = useSession();
  const router = useRouter();

  const [data, setData] = useState<HomeBookings | null>(null);
  const [money, setMoney] = useState<HomeMoney | null>(null);
  const [failed, setFailed] = useState(false);

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';
  const currency = business?.default_currency ?? 'USD';

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    setFailed(false);
    try {
      const [bookings, totals] = await Promise.all([
        getHomeBookings(businessId, timezone),
        getHomeMoney(businessId, timezone, currency),
      ]);
      setData(bookings);
      setMoney(totals);
    } catch {
      setFailed(true);
    }
  }, [businessId, timezone, currency]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;

  const fullName = user?.user_metadata?.full_name;
  const name = typeof fullName === 'string' && fullName ? fullName : (user?.email ?? '');

  return (
    <Screen>
      <Title title={business.business_name} subtitle={t('dashboard.welcome', { name })} />

      {failed ? <Banner tone="error">{t('error.network')}</Banner> : null}

      {money ? (
        <View style={styles.metricsSection}>
          <Text style={styles.section}>{t('payment.title')}</Text>
          <View style={styles.metrics}>
            <Metric
              label={t('dashboard.balanceDue')}
              value={formatMoney(locale, money.balanceDue, money.currency)}
              featured
            />
            <Metric
              label={t('dashboard.paidToday')}
              value={formatMoney(locale, money.paidToday, money.currency)}
            />
            <Metric label={t('dashboard.unpaid')} value={money.unpaid} />
            <Metric label={t('dashboard.deposits')} value={money.awaitingDeposit} />
          </View>
        </View>
      ) : null}

      {data === null ? (
        <Loading />
      ) : (
        <>
          {data.expired.length > 0 ? (
            <>
              <Banner tone="error">{t('booking.pending.review.body')}</Banner>
              <BookingList
                titleKey="dashboard.expired"
                bookings={data.expired}
                field="check_in_at"
              />
            </>
          ) : null}

          <BookingList titleKey="dashboard.today" bookings={data.today} field="check_in_at" />
          <BookingList titleKey="dashboard.checkIns" bookings={data.checkIns} field="check_in_at" />
          <BookingList
            titleKey="dashboard.checkOuts"
            bookings={data.checkOuts}
            field="check_out_at"
          />
          <BookingList titleKey="dashboard.pending" bookings={data.pending} field="check_in_at" />

          <Text style={styles.section}>{t('dashboard.available')}</Text>
          {data.availableProperties.length === 0 ? (
            <Text style={styles.muted}>{t('dashboard.none')}</Text>
          ) : (
            <View style={styles.chips}>
              {data.availableProperties.map((property) => (
                <Badge key={property.id}>{property.name}</Badge>
              ))}
            </View>
          )}
        </>
      )}

      <Card>
        <Row label={t('dashboard.role')} value={<Badge>{t(`role.${business.role}`)}</Badge>} />
        <Row label={t('dashboard.members')} value={business.member_count} />
        <Row label={t('settings.business.currency')} value={business.default_currency} />
      </Card>

      {data !== null && data.today.length === 0 && data.checkIns.length === 0 ? (
        <Empty title={t('dashboard.empty.title')} body={t('dashboard.empty.body')} />
      ) : null}

      <View style={styles.footer}>
        <LanguageToggle />
        <Button
          label={t('nav.settings')}
          variant="secondary"
          onPress={() => router.push('/settings')}
        />
        <Button label={t('common.signOut')} variant="secondary" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 4,
  },
  section: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.text,
  },
  sectionCount: {
    minWidth: 28,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.brandSoft,
    color: colors.brandDark,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  muted: { fontSize: 13, color: colors.muted },
  emptyLine: { marginTop: -12, fontSize: 14, color: colors.muted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderLeftWidth: 3,
    padding: 16,
    gap: 5,
    shadowColor: colors.brandDark,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.06,
    shadowRadius: 14,
    elevation: 2,
  },
  cardPressed: { opacity: 0.72 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: colors.text },
  metricsSection: { gap: 12 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metric: {
    width: '48%',
    minHeight: 126,
    flexGrow: 1,
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    shadowColor: colors.brandDark,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.06,
    shadowRadius: 14,
    elevation: 2,
  },
  metricFeatured: { backgroundColor: colors.brandDark },
  metricMarker: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brandSoft },
  metricMarkerFeatured: { backgroundColor: colors.accent },
  metricLabel: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.muted },
  metricLabelFeatured: { color: '#c8d9cb' },
  metricValue: {
    fontSize: 24,
    lineHeight: 29,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: colors.text,
  },
  metricValueFeatured: { color: '#ffffff' },
  footer: { gap: 12, paddingTop: 8 },
});
