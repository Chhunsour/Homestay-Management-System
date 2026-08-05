import { useCallback, useState } from 'react';
import { Link, router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { addMonths, can, coversDate, monthGrid, statusLabel } from '@homestay/shared';
import type { BookingWithDetails, Property } from '@homestay/shared';
import { Banner, Button, Empty, Screen, StatusDot, Title, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { listBookableProperties, listCalendarBookings, todayIn } from '@/lib/bookings';

/** `YYYY-MM-DD` shifted by whole days, without pulling in a date library. */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export default function CalendarTab() {
  const { t, locale, business } = useSession();
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';
  const today = todayIn(timezone);

  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [propertyId, setPropertyId] = useState('');
  const [bookings, setBookings] = useState<BookingWithDetails[] | null>(null);
  const [properties, setProperties] = useState<Pick<Property, 'id' | 'name'>[]>([]);
  const [failed, setFailed] = useState(false);

  const businessId = business?.business_id;
  const days = monthGrid(month);

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    setFailed(false);
    // Recomputed here rather than closed over: the grid is a new array every
    // render, and a changing dependency would reload on every render.
    const grid = monthGrid(month);
    try {
      const [rows, list] = await Promise.all([
        listCalendarBookings(
          businessId,
          timezone,
          {
            from: grid[0] ?? `${month}-01`,
            to: shiftDays(grid[grid.length - 1] ?? `${month}-01`, 1),
          },
          propertyId || undefined,
        ),
        listBookableProperties(businessId),
      ]);
      // Cancelled stays free the dates, so they do not belong on the grid.
      setBookings(rows.filter((booking) => booking.status?.code !== 'cancelled'));
      setProperties(list);
    } catch {
      setFailed(true);
      setBookings([]);
    }
  }, [businessId, timezone, month, propertyId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;

  const heading = new Intl.DateTimeFormat(locale === 'km' ? 'km-KH' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));

  const weekdayNames = new Intl.DateTimeFormat(locale === 'km' ? 'km-KH' : 'en-GB', {
    weekday: 'narrow',
    timeZone: 'UTC',
  });

  const stays = (day: string) =>
    (bookings ?? []).filter((booking) => coversDate(booking, day, timezone));
  const onSelected = stays(selected);

  return (
    <Screen>
      <Title title={t('calendar.title')} subtitle={t('calendar.subtitle')} />

      {can(business.role, 'bookings.manage') ? (
        <Button label={t('booking.new')} onPress={() => router.push('/booking/new')} />
      ) : null}

      <View style={styles.nav}>
        <Button
          label={t('calendar.previous')}
          variant="secondary"
          onPress={() => setMonth((current) => addMonths(current, -1))}
        />
        <Text style={styles.heading}>{heading}</Text>
        <Button
          label={t('calendar.next')}
          variant="secondary"
          onPress={() => setMonth((current) => addMonths(current, 1))}
        />
      </View>
      <Button
        label={t('calendar.today')}
        variant="ghost"
        onPress={() => {
          setMonth(today.slice(0, 7));
          setSelected(today);
        }}
      />

      <ChoiceGroup
        label={t('booking.property')}
        options={['', ...properties.map((property) => property.id)]}
        value={propertyId}
        onChange={setPropertyId}
        renderLabel={(id) =>
          properties.find((property) => property.id === id)?.name ?? t('calendar.allProperties')
        }
      />

      {failed ? <Banner tone="error">{t('error.network')}</Banner> : null}

      {bookings === null ? (
        <Loading />
      ) : (
        <>
          <View style={styles.grid}>
            {days.slice(0, 7).map((day) => (
              <Text key={`head-${day}`} style={styles.weekday}>
                {weekdayNames.format(new Date(`${day}T00:00:00Z`))}
              </Text>
            ))}
            {days.map((day) => {
              const count = stays(day).length;
              const outside = day.slice(0, 7) !== month;
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={day}
                  accessibilityState={{ selected: day === selected }}
                  onPress={() => setSelected(day)}
                  style={[
                    styles.cell,
                    outside ? styles.cellOutside : null,
                    day === selected ? styles.cellSelected : null,
                  ]}
                >
                  <Text style={[styles.cellDay, day === today ? styles.cellToday : null]}>
                    {Number(day.slice(8))}
                  </Text>
                  {count > 0 ? <Text style={styles.cellCount}>{count}</Text> : null}
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.legend}>{t('calendar.legend')}</Text>

          {onSelected.length === 0 ? (
            <Empty title={t('calendar.empty')} body={selected} />
          ) : (
            onSelected.map((booking) => (
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
                  <Text style={styles.cardMeta}>
                    {`${booking.customer?.full_name ?? ''} · ${
                      booking.status ? statusLabel(booking.status, t) : ''
                    }`}
                  </Text>
                </Pressable>
              </Link>
            ))
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.text },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekday: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: 12,
    color: colors.muted,
    paddingVertical: 4,
  },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  cellOutside: { backgroundColor: colors.canvas },
  cellSelected: { borderColor: colors.brand, borderWidth: 2 },
  cellDay: { fontSize: 13, color: colors.text },
  cellToday: { fontWeight: '700', color: colors.brandDark },
  cellCount: { fontSize: 11, fontWeight: '600', color: colors.brandDark },
  legend: { fontSize: 12, color: colors.muted },

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
  cardMeta: { fontSize: 13, color: colors.muted },
});
