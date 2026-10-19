import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, toneColors, type Tone } from '@/theme/theme';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from './Icon';

type ToastFn = (message: string, tone?: Tone) => void;
const Ctx = createContext<ToastFn>(() => undefined);

interface Item {
  id: number;
  message: string;
  tone: Tone;
}

/** Short confirmation messages ("Attendance saved", errors) shown above the tab bar. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<Item | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const { font } = useI18n();

  const show = useCallback<ToastFn>((message, tone = 'success') => {
    if (timer.current) clearTimeout(timer.current);
    setItem({ id: Date.now(), message, tone });
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    timer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => setItem(null));
    }, tone === 'critical' ? 4200 : 2600);
  }, [opacity]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const tc = item ? toneColors[item.tone] : toneColors.success;
  return (
    <Ctx.Provider value={show}>
      {children}
      {item && (
        <Animated.View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 72, opacity }]}>
          <View style={[styles.toast, { borderLeftColor: tc.solid }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
            <Icon name={item.tone === 'critical' ? 'alert' : item.tone === 'success' ? 'check' : 'info'} size={18} color={tc.solid} />
            <Text style={[styles.text, { fontFamily: font('medium') }]}>{item.message}</Text>
          </View>
        </Animated.View>
      )}
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 12, borderLeftWidth: 4, maxWidth: 520, width: '100%',
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  text: { color: colors.textInvert, fontSize: 14, flex: 1 },
});
