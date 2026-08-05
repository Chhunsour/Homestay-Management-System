import { ActivityIndicator, View } from 'react-native';
import { colors } from '@/components/ui';

export function Loading() {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.canvas,
      }}
    >
      <ActivityIndicator color={colors.brand} />
    </View>
  );
}
