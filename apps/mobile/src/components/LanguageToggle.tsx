import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LOCALES, type Locale, type TranslationKey } from '@homestay/shared';
import { colors } from '@/components/ui';
import { useSession } from '@/lib/session';

const LABEL_KEYS: Record<Locale, TranslationKey> = {
  en: 'common.english',
  km: 'common.khmer',
};

export function LanguageToggle() {
  const { locale, setLocale, t } = useSession();

  return (
    <View
      style={styles.group}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('common.language')}
    >
      {LOCALES.map((option) => {
        const selected = option === locale;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={t(LABEL_KEYS[option])}
            onPress={() => void setLocale(option)}
            style={[styles.option, selected ? styles.optionSelected : null]}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : null]}>
              {t(LABEL_KEYS[option])}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', gap: 8 },
  option: {
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bcc8be',
    backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  label: { fontSize: 14, fontWeight: '600', color: colors.muted },
  labelSelected: { color: colors.brandDark },
});
