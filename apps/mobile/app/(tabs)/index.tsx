import { useCallback, useState } from 'react';
import { Link, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDateTime, statusLabel } from '@homestay/shared';
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
      <Text style={styles.section}>{`${t(titleKey)} · ${bookings.length}`}</Text>
      {bookings.length === 0 ? (
        <Text style={styles.muted}>{t('dashboard.none')}</Text>
      ) : (
        bookings.slice(0, 5).map((booking) => (
          <Link key={booking.id} href={`/booking/${booking.id}`} asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={booking.booking_number}
              style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
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

export default function HomeScreen() {
  const { t, user, business, signOut } = useSession();

  const [data, setData] = useState<HomeBookings | null>(null);
  const [failed, setFailed] = useState(false);

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    setFailed(false);
    try {
      setData(await getHomeBookings(businessId, timezone));
    } catch {
      setFailed(true);
    }
  }, [businessId, timezone]);

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

      {money ? (
        <>
          <Text style={styles.section}>{t('payment.title')}</Text>
          <Card>
            <Row label={t('dashboard.unpaid')} value={money.unpaid} />
            <Row label={t('dashboard.deposits')} value={money.awaitingDeposit} />
            <Row
              label={t('dashboard.balanceDue')}
              value={formatMoney(locale, money.balanceDue, money.currency)}
            />
            <Row
              label={t('dashboard.paidToday')}
              value={formatMoney(locale, money.paidToday, money.currency)}
            />
          </Card>
        </>
      ) : null}

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
        <Button label={t('common.signOut')} variant="secondary" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 16, fontWeight: '600', color: colors.text, paddingTop: 8 },
  muted: { fontSize: 13, color: colors.muted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    gap: 4,
  },
  cardPressed: { opacity: 0.85 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  footer: { gap: 12, paddingTop: 4 },
});
