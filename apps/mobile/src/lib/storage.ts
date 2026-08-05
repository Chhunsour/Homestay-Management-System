import AsyncStorage from '@react-native-async-storage/async-storage';

const memoryStore = new Map<string, string>();

/**
 * Robust storage implementation that falls back gracefully to in-memory storage
 * if native AsyncStorage module is unavailable or throws (e.g. in Expo Go / simulator).
 */
export const safeStorage = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      return await AsyncStorage.getItem(key);
    } catch (err) {
      console.warn(`[safeStorage] AsyncStorage.getItem failed for key "${key}", falling back to memory store:`, err);
      return memoryStore.get(key) ?? null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      await AsyncStorage.setItem(key, value);
    } catch (err) {
      console.warn(`[safeStorage] AsyncStorage.setItem failed for key "${key}", falling back to memory store:`, err);
      memoryStore.set(key, value);
    }
  },
  removeItem: async (key: string): Promise<void> => {
    try {
      await AsyncStorage.removeItem(key);
    } catch (err) {
      console.warn(`[safeStorage] AsyncStorage.removeItem failed for key "${key}", falling back to memory store:`, err);
      memoryStore.delete(key);
    }
  },
};
