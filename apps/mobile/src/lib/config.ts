import { Platform } from 'react-native';

/**
 * Where the app finds the Holy Sai API and the web portal.
 *
 * Set EXPO_PUBLIC_API_URL (and EXPO_PUBLIC_WEB_URL) in apps/mobile/.env or in an eas.json build profile.
 * Defaults suit local development: the Android emulator reaches the host machine at 10.0.2.2,
 * the iOS simulator at localhost. A physical phone needs the computer's LAN address instead,
 * e.g. EXPO_PUBLIC_API_URL=http://192.168.1.20:4000/api.
 */
const devHost = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';

function trimSlash(v: string) {
  return v.replace(/\/+$/, '');
}

export const API_URL = trimSlash(process.env.EXPO_PUBLIC_API_URL || `http://${devHost}:4000/api`);

/** The web portal, for features that have no native screen yet (opened in the browser). */
export const WEB_URL = trimSlash(process.env.EXPO_PUBLIC_WEB_URL || `http://${devHost}:5173`);

export const SCHOOL_TIMEZONE = 'Asia/Kolkata';
