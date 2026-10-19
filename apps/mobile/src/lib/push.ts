import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from '@/api/client';

/**
 * Expo push notifications. After sign-in (or a restored session) the app asks for permission once and registers
 * the device's Expo push token with the API (`PUT /auth/push-token`); the API delivers school alerts to it through
 * the Push integration, following each user's notification preferences. Signing out on the phone removes the token
 * on the server, so a shared device never receives the previous user's alerts.
 */
export const PUSH_TOKEN_ENDPOINT = '/auth/push-token';

/** Registers this device for the signed-in user. Never throws — notifications are optional. */
export async function syncPushToken(): Promise<void> {
  try {
    const token = await registerForPushNotifications();
    if (token) await api.put(PUSH_TOKEN_ENDPOINT, { token, platform: Platform.OS });
  } catch {
    /* permission denied, no EAS project yet, or offline — try again at the next sign-in */
  }
}

export async function registerForPushNotifications(): Promise<string | null> {
  // Remote push needs a real device and a development / store build (not Expo Go on Android).
  if (!Device.isDevice || Constants.executionEnvironment === 'storeClient') return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'School alerts',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#990033',
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null; // set by `eas init`
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}
