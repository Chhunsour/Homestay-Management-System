import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/components/ui';

/** Radio group for the short option lists Phase 1 needs (language, currency, time zone). */
export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  renderLabel,
  error,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  renderLabel?: (option: T) => string;
  error?: string;
}) {
  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((option) => {
          const selected = option === value;
          const text = renderLabel ? renderLabel(option) : option;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={text}
              onPress={() => onChange(option)}
              style={[styles.option, selected ? styles.optionSelected : null]}
            >
              <Text style={[styles.optionText, selected ? styles.optionTextSelected : null]}>
                {text}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 6 },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bcc8be',
    backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  optionText: { fontSize: 14, color: colors.muted },
  optionTextSelected: { color: colors.brandDark, fontWeight: '600' },
  error: { fontSize: 12, fontWeight: '500', color: colors.danger },
});
