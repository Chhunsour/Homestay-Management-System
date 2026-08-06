import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { PHOTO_MAX_BYTES } from '@homestay/shared';
import type { PropertyPhoto, TranslationKey } from '@homestay/shared';
import { Badge, Banner, Button, colors } from '@/components/ui';
import { useSession } from '@/lib/session';
import { deletePhoto, setCoverPhoto, uploadPhoto } from '@/lib/properties';

const MAX_SIZE_LABEL = `${Math.round(PHOTO_MAX_BYTES / 1024 / 1024)} MB`;

export function PhotoManager({
  propertyId,
  photos,
  urls,
  canManage,
  onChanged,
}: {
  propertyId: string;
  photos: PropertyPhoto[];
  urls: Record<string, string>;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t, business } = useSession();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  async function pickAndUpload(): Promise<void> {
    if (!business) return;
    setErrorKey(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return setErrorKey('photo.permissionDenied');

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;

    setBusy(true);
    try {
      const failed = await uploadPhoto(business.business_id, propertyId, {
        uri: asset.uri,
        fileName: asset.fileName ?? null,
        mimeType: asset.mimeType ?? null,
        fileSize: asset.fileSize ?? null,
      });
      if (failed) return setErrorKey(failed);
      onChanged();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<TranslationKey | null>): Promise<void> {
    setErrorKey(null);
    setBusy(true);
    try {
      const failed = await action();
      if (failed) return setErrorKey(failed);
      onChanged();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(photoId: string): void {
    if (!business) return;
    Alert.alert(t('photo.delete'), t('photo.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => void run(() => deletePhoto(business.business_id, photoId)),
      },
    ]);
  }

  return (
    <View style={styles.wrapper}>
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      {canManage ? (
        <>
          <Text style={styles.hint}>{t('photo.subtitle', { size: MAX_SIZE_LABEL })}</Text>
          <Button
            label={busy ? t('photo.uploading') : t('photo.upload')}
            variant="secondary"
            loading={busy}
            onPress={() => void pickAndUpload()}
          />
        </>
      ) : null}

      {photos.length === 0 ? (
        <Text style={styles.empty}>{t('photo.empty')}</Text>
      ) : (
        photos.map((photo) => {
          const uri = urls[photo.storage_path];
          return (
            <View key={photo.id} style={styles.item}>
              {uri ? (
                <Image source={{ uri }} style={styles.image} accessibilityIgnoresInvertColors />
              ) : null}
              <View style={styles.itemBar}>
                {photo.is_cover ? <Badge>{t('photo.cover')}</Badge> : <View />}
                {canManage ? (
                  <View style={styles.itemActions}>
                    {photo.is_cover ? null : (
                      <Button
                        label={t('photo.setCover')}
                        variant="ghost"
                        disabled={busy}
                        onPress={() => void run(() => setCoverPhoto(photo.id))}
                      />
                    )}
                    <Button
                      label={t('common.delete')}
                      variant="ghost"
                      disabled={busy}
                      onPress={() => confirmDelete(photo.id)}
                    />
                  </View>
                ) : null}
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 12 },
  hint: { fontSize: 12, color: colors.muted },
  empty: { fontSize: 14, color: colors.muted },
  item: { borderRadius: 16, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  image: { width: '100%', height: 190, backgroundColor: colors.brandSoft },
  itemBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surface,
  },
  itemActions: { flexDirection: 'row', alignItems: 'center' },
});
