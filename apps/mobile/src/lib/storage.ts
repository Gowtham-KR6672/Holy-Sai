import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const REFRESH_KEY = 'hs.refreshToken';

/**
 * The refresh token lives in the platform keychain / keystore (expo-secure-store).
 * The access token is never persisted — it stays in memory only.
 * (The web build, used only for smoke tests, falls back to localStorage.)
 */
export const tokenStore = {
  async get(): Promise<string | null> {
    try {
      if (Platform.OS === 'web') return globalThis.localStorage?.getItem(REFRESH_KEY) ?? null;
      return await SecureStore.getItemAsync(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  async set(token: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(REFRESH_KEY, token);
      return;
    }
    await SecureStore.setItemAsync(REFRESH_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  },
  async clear(): Promise<void> {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.removeItem(REFRESH_KEY);
      else await SecureStore.deleteItemAsync(REFRESH_KEY);
    } catch {
      /* nothing stored */
    }
  },
};

/** Small, non-sensitive preferences (language, last selected child). */
export const prefs = {
  async get(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      /* preference simply isn't remembered */
    }
  },
};
