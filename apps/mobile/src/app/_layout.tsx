import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Montserrat_400Regular, Montserrat_500Medium, Montserrat_600SemiBold, Montserrat_700Bold } from '@expo-google-fonts/montserrat';
import { NotoSansTamil_400Regular, NotoSansTamil_500Medium, NotoSansTamil_600SemiBold, NotoSansTamil_700Bold } from '@expo-google-fonts/noto-sans-tamil';
import {
  NotoSansDevanagari_400Regular, NotoSansDevanagari_500Medium, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold,
} from '@expo-google-fonts/noto-sans-devanagari';
import { ApiError } from '@/api/client';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { I18nProvider, useI18n } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/Toast';
import { colors } from '@/theme/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

// Refetch on return to the app (React Query's "window focus" for React Native).
focusManager.setEventListener((handleFocus) => {
  if (Platform.OS === 'web') return undefined;
  const sub = AppState.addEventListener('change', (s) => handleFocus(s === 'active'));
  return () => sub.remove();
});

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry network hiccups once; never retry 4xx/5xx answers (endpoints still being built answer 404/501).
        retry: (count, err) => count < 1 && err instanceof ApiError && err.isNetwork,
      },
    },
  });
}

export default function RootLayout() {
  const [client] = useState(makeClient);
  const [fontsLoaded, fontError] = useFonts({
    Montserrat_400Regular, Montserrat_500Medium, Montserrat_600SemiBold, Montserrat_700Bold,
    NotoSansTamil_400Regular, NotoSansTamil_500Medium, NotoSansTamil_600SemiBold, NotoSansTamil_700Bold,
    NotoSansDevanagari_400Regular, NotoSansDevanagari_500Medium, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold,
  });
  const fontsReady = fontsLoaded || !!fontError;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider>
              <StatusBar style="dark" />
              <SplashGate fontsReady={fontsReady} />
              {fontsReady && (
                <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
                  <Stack.Screen name="index" />
                  <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
                  <Stack.Screen name="(app)" options={{ animation: 'fade' }} />
                </Stack>
              )}
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Keeps the native splash screen up until fonts, the saved language and the saved session are ready. */
function SplashGate({ fontsReady }: { fontsReady: boolean }) {
  const { status } = useAuth();
  const { ready } = useI18n();
  useEffect(() => {
    if (fontsReady && ready && status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsReady, ready, status]);
  return null;
}
