import { useCallback, useEffect, useState } from 'react';
import { Link, router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BOOKING_FILTERS,
  can,
  finalPrice,
  formatDate,
  formatMoney,
  isPendingExpired,
  statusLabel,
} from '@homestay/shared';
import type { BookingFilter, BookingWithDetails, Property, TranslationKey } from '@homestay/shared';
import {
  Badge,
  Banner,
  Button,
  Empty,
  Field,
  Screen,
  StatusDot,
  Title,
  colors,
} from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { listBookableProperties, listBookings } from '@/lib/bookings';

const FILTER_LABELS: Record<BookingFilter, TranslationKey> = {
  upcoming: 'booking.filter.upcoming',
  today: 'booking.filter.today',
  expired: 'booking.filter.expired',
  all: 'common.all',
};

export default function BookingsTab() {
  const { t, locale, business } = useSession();

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<BookingFilter>('upcoming');
  const [propertyId, setPropertyId] = useState('');
  const [page, setPage] = useState(1);
  const [bookings, setBookings] = useState<BookingWithDetails[] | null>(null);
  const [properties, setProperties] = useState<Pick<Property, 'id' | 'name'>[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  // Typing must not fire a query per keystroke; the list settles 300ms later.
  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    setFailed(false);
    try {
      const [result, list] = await Promise.all([
        listBookings(businessId, timezone, {
          search: term,
          filter,
          propertyId: propertyId || undefined,
          page,
        }),
        listBookableProperties(businessId),
      ]);
      setBookings(result.bookings);
      setHasMore(result.hasMore);
      setProperties(list);
    } catch {
      setFailed(true);
      setBookings([]);
    }
  }, [businessId, timezone, term, filter, propertyId, page]);

  // Reloads on every focus, so a save on the detail screen shows up on return.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;
  const canManage = can(business.role, 'bookings.manage');
  const now = new Date();

  return (
    <Screen>
      <Title title={t('booking.title')} subtitle={t('booking.subtitle')} />

      {canManage ? (
        <Button label={t('booking.new')} onPress={() => router.push('/booking/new')} />
      ) : null}

      <Field
        label={t('booking.search')}
        value={search}
        onChangeText={setSearch}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ChoiceGroup
        label={t('common.all')}
        options={BOOKING_FILTERS}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setPage(1);
        }}
        renderLabel={(option) => t(FILTER_LABELS[option])}
      />
      <ChoiceGroup
        label={t('booking.property')}
        options={['', ...properties.map((property) => property.id)]}
        value={propertyId}
        onChange={(next) => {
          setPropertyId(next);
          setPage(1);
        }}
        renderLabel={(id) =>
          properties.find((property) => property.id === id)?.name ?? t('calendar.allProperties')
        }
      />

      {failed ? <Banner tone="error">{t('error.network')}</Banner> : null}

      {bookings === null ? (
        <Loading />
      ) : bookings.length === 0 ? (
        <Empty
          title={t('booking.empty.title')}
          body={
            term || filter !== 'upcoming' || propertyId
              ? t('booking.empty.filtered')
              : t('booking.empty.body')
          }
        />
      ) : (
        <>
          {bookings.map((booking) => (
            <Link key={booking.id} href={`/booking/${booking.id}`} asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={booking.booking_number}
                style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
              >
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{booking.property?.name}</Text>
                  <View style={styles.status}>
                    <StatusDot color={booking.status?.color ?? colors.muted} />
                    <Text style={styles.cardMeta}>
                      {booking.status ? statusLabel(booking.status, t) : ''}
                    </Text>
                  </View>
                </View>
                <Text style={styles.cardMeta}>
                  {`${booking.booking_number} · ${booking.customer?.full_name ?? ''}`}
                </Text>
                <Text style={styles.cardMeta}>
                  {`${formatDate(locale, booking.check_in_at, timezone)} → ${formatDate(
                    locale,
                    booking.check_out_at,
                    timezone,
                  )}`}
                </Text>
                <View style={styles.cardFoot}>
                  <Text style={styles.price}>
                    {formatMoney(locale, finalPrice(booking), booking.currency)}
                  </Text>
                  {booking.conflict_override ? <Badge>{t('booking.conflict.badge')}</Badge> : null}
                  {isPendingExpired(booking, now) ? (
                    <Badge>{t('booking.pending.expired')}</Badge>
                  ) : null}
                </View>
              </Pressable>
            </Link>
          ))}

          <Text style={styles.count}>{t('booking.count', { count: String(bookings.length) })}</Text>
          {hasMore ? (
            <Button
              label={t('booking.more')}
              variant="secondary"
              onPress={() => setPage((current) => current + 1)}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
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
  cardMeta: { fontSize: 13, color: colors.muted },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  price: { fontSize: 14, fontWeight: '600', color: colors.text },
  count: { fontSize: 13, color: colors.muted, textAlign: 'center' },
});
