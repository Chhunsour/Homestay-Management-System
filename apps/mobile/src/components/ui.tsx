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
  brand: '#2e543e',
  brandDark: '#182d22',
  brandSoft: '#e2ebe4',
  accent: '#c8783a',
  accentSoft: '#fff1e4',
  text: '#18231d',
  muted: '#526057',
  subtle: '#7d8b80',
  line: '#dce4dc',
  surface: '#fcfdfb',
  canvas: '#f2f5f0',
  danger: '#a83d3d',
  dangerSoft: '#fcedeb',
  success: '#397150',
  successSoft: '#e5f1e8',
} as const;

const RADIUS = 18;

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
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
      <View accessibilityElementsHidden style={styles.titleMarker} />
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
      <View accessibilityElementsHidden style={styles.emptyMarker} />
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
        placeholderTextColor={colors.subtle}
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
  scrollContent: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 20,
  },

  titleBlock: { gap: 6, paddingBottom: 4 },
  titleMarker: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
    marginBottom: 8,
  },
  title: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.7,
    color: colors.text,
  },
  subtitle: { maxWidth: 560, fontSize: 15, lineHeight: 23, color: colors.muted },

  card: {
    backgroundColor: colors.surface,
    borderRadius: RADIUS,
    overflow: 'hidden',
    shadowColor: colors.brandDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 2,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    minHeight: 54,
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowLabel: { fontSize: 14, lineHeight: 20, color: colors.muted, flexShrink: 1 },
  rowValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
    textAlign: 'right',
  },

  badge: {
    backgroundColor: colors.brandSoft,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeText: { fontSize: 12, fontWeight: '600', color: colors.brandDark },

  dot: { width: 10, height: 10, borderRadius: 5 },

  banner: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 13 },
  banner_error: { backgroundColor: colors.dangerSoft, borderColor: '#e8b9b5' },
  banner_success: { backgroundColor: colors.successSoft, borderColor: '#b9d6c0' },
  banner_info: { backgroundColor: colors.brandSoft, borderColor: '#c4d7c9' },
  bannerText: { fontSize: 14, lineHeight: 21 },
  bannerText_error: { color: colors.danger },
  bannerText_success: { color: colors.success },
  bannerText_info: { color: colors.muted },

  empty: {
    backgroundColor: colors.surface,
    borderRadius: RADIUS,
    padding: 30,
    gap: 8,
    alignItems: 'center',
  },
  emptyMarker: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    marginBottom: 6,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 22, color: colors.muted, textAlign: 'center' },

  field: { gap: 7 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: {
    minHeight: 52,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#bcc8be',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  inputError: { borderColor: '#f87171' },
  hint: { fontSize: 12, color: '#64748b' },
  error: { fontSize: 12, fontWeight: '500', color: colors.danger },

  button: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  button_primary: { backgroundColor: colors.brand },
  button_secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: '#bcc8be' },
  button_ghost: { backgroundColor: 'transparent' },
  buttonPressed: { opacity: 0.76 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  buttonText_primary: { color: '#ffffff' },
  buttonText_secondary: { color: colors.text },
  buttonText_ghost: { color: colors.brandDark },
});
