import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = {
  brand: '#0f766e',
  brandDark: '#115e59',
  brandSoft: '#f0fdfa',
  text: '#0f172a',
  muted: '#475569',
  line: '#e2e8f0',
  surface: '#ffffff',
  canvas: '#f8fafc',
  danger: '#b91c1c',
  dangerSoft: '#fef2f2',
  success: '#047857',
  successSoft: '#ecfdf5',
} as const;

/** Slight rounding everywhere — matches the web design tokens. */
const RADIUS = 6;

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.scrollContent}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

export function Badge({ children }: { children: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{children}</Text>
    </View>
  );
}

/** A booking status, as its colour — a coloured pill is unreadable this small. */
export function StatusDot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

export function Banner({
  tone,
  children,
}: {
  tone: 'error' | 'success' | 'info';
  children: string;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === 'error' ? 'alert' : 'text'}
      style={[styles.banner, styles[`banner_${tone}`]]}
    >
      <Text style={[styles.bannerText, styles[`bannerText_${tone}`]]}>{children}</Text>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        // Screen readers read the label with the field; there is no <label for>.
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor="#94a3b8"
        {...props}
        style={[styles.input, error ? styles.inputError : null]}
      />
      {hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
}) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[`button_${variant}`],
        pressed && !isDisabled ? styles.buttonPressed : null,
        isDisabled ? styles.buttonDisabled : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#ffffff' : colors.brand} />
      ) : (
        <Text style={[styles.buttonText, styles[`buttonText_${variant}`]]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  scrollContent: { padding: 20, gap: 16 },

  titleBlock: { gap: 4 },
  title: { fontSize: 22, fontWeight: '600', color: colors.text },
  subtitle: { fontSize: 14, lineHeight: 22, color: colors.muted },

  card: {
    backgroundColor: colors.surface,
    borderRadius: RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowLabel: { fontSize: 14, color: colors.muted, flexShrink: 1 },
  rowValue: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    flexShrink: 1,
    textAlign: 'right',
  },

  badge: {
    backgroundColor: colors.brandSoft,
    borderColor: '#99f6e4',
    borderWidth: 1,
    borderRadius: RADIUS,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 12, fontWeight: '500', color: colors.brandDark },

  dot: { width: 8, height: 8, borderRadius: 4 },

  banner: { borderRadius: RADIUS, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  banner_error: { backgroundColor: colors.dangerSoft, borderColor: '#fecaca' },
  banner_success: { backgroundColor: colors.successSoft, borderColor: '#a7f3d0' },
  banner_info: { backgroundColor: colors.canvas, borderColor: colors.line },
  bannerText: { fontSize: 14, lineHeight: 21 },
  bannerText_error: { color: colors.danger },
  bannerText_success: { color: colors.success },
  bannerText_info: { color: colors.muted },

  empty: {
    backgroundColor: colors.surface,
    borderRadius: RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 24,
    gap: 6,
    alignItems: 'center',
  },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: colors.text, textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 22, color: colors.muted, textAlign: 'center' },

  field: { gap: 6 },
  fieldLabel: { fontSize: 14, fontWeight: '500', color: colors.text },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: RADIUS,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  inputError: { borderColor: '#f87171' },
  hint: { fontSize: 12, color: '#64748b' },
  error: { fontSize: 12, fontWeight: '500', color: colors.danger },

  button: {
    minHeight: 44,
    borderRadius: RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  button_primary: { backgroundColor: colors.brand },
  button_secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: '#cbd5e1' },
  button_ghost: { backgroundColor: 'transparent' },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  buttonText_primary: { color: '#ffffff' },
  buttonText_secondary: { color: colors.text },
  buttonText_ghost: { color: colors.brandDark },
});
