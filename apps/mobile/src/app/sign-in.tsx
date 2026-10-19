import { useRef, useState, type ComponentRef } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import type { PublicConfig } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toast';
import { Banner, Button, Row, Txt } from '@/components/ui';
import { tabsFor } from '@/lib/features';
import { colors, radius, space } from '@/theme/theme';

const AUDIENCES = [
  { icon: 'heart', label: 'Parents' },
  { icon: 'graduation', label: 'Students' },
  { icon: 'bookOpen', label: 'Teachers' },
  { icon: 'idCard', label: 'Staff' },
  { icon: 'shield', label: 'Leaders' },
];

export default function SignIn() {
  const { signIn } = useAuth();
  const { t, lang, langs, setLang, font } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const config = useApiQuery<PublicConfig>('/public/config', undefined, { staleTime: 5 * 60_000 });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const pwRef = useRef<ComponentRef<typeof TextInput>>(null);

  const submit = async () => {
    if (!identifier.trim() || !password) {
      setError(t('Enter your email or mobile number and your password.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await signIn(identifier.trim(), password);
      setPassword('');
      toast(t('Welcome, {name}', { name: user.fullName }), 'success');
      if (user.mustChangePassword) router.replace('/view/account?tab=password');
      else router.replace(`/${tabsFor(user)[0].key}`);
    } catch (err) {
      setError(err instanceof ApiError ? t(err.message) : t('Sign-in failed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const school = config.data?.schoolName ?? 'Holy Sai International School';
  const tagline = config.data?.tagline || 'Growing Minds. Inspiring Futures.';

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <View style={styles.langRow} accessibilityRole="radiogroup" accessibilityLabel={t('Language')}>
          {langs.map((l) => {
            const on = l.id === lang;
            return (
              <Pressable key={l.id} onPress={() => setLang(l.id)} style={[styles.langPill, on && styles.langPillOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                <Txt variant="small" weight="semibold" color={on ? colors.textInvert : colors.brandStrong}>{l.label}</Txt>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.brand}>
          <Image source={require('../../assets/images/logo-mark.webp')} style={styles.logo} resizeMode="contain" accessibilityLabel={school} />
          <Txt variant="display" center color={colors.brandStrong}>{t('Holy Sai')}</Txt>
          <Txt variant="h3" center color={colors.brand}>{t('Smart School 360')}</Txt>
          <Txt variant="small" center>{school}</Txt>
          <Txt variant="small" center color={colors.accentStrong} weight="semibold">{t(tagline)}</Txt>
        </View>

        <View style={styles.card}>
          <Txt variant="h2">{t('Sign in to Campus')}</Txt>
          <Txt variant="small">{t('One app for parents, students, teachers and staff — you see what your role allows.')}</Txt>

          {error && <Banner tone="critical" icon="alert">{error}</Banner>}

          <View style={{ gap: 6 }}>
            <Txt variant="small" weight="semibold" color={colors.text}>{t('Email or mobile number')}</Txt>
            <View style={styles.inputWrap}>
              <Icon name="user" size={18} color={colors.textMuted} />
              <TextInput
                value={identifier}
                onChangeText={setIdentifier}
                placeholder={t('Email or mobile number')}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                keyboardType="email-address"
                returnKeyType="next"
                onSubmitEditing={() => pwRef.current?.focus()}
                style={[styles.input, { fontFamily: font('regular') }]}
                accessibilityLabel={t('Email or mobile number')}
              />
            </View>
          </View>

          <View style={{ gap: 6 }}>
            <Txt variant="small" weight="semibold" color={colors.text}>{t('Password')}</Txt>
            <View style={styles.inputWrap}>
              <Icon name="lock" size={18} color={colors.textMuted} />
              <TextInput
                ref={pwRef}
                value={password}
                onChangeText={setPassword}
                placeholder={t('Password')}
                placeholderTextColor={colors.textFaint}
                secureTextEntry={!show}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                style={[styles.input, { fontFamily: font('regular') }]}
                accessibilityLabel={t('Password')}
              />
              <Pressable onPress={() => setShow((s) => !s)} hitSlop={10} accessibilityRole="button" accessibilityLabel={show ? t('Hide password') : t('Show password')}>
                <Icon name='eye' size={18} color={show ? colors.brand : colors.textMuted} />
              </Pressable>
            </View>
            <Pressable onPress={() => setShow((s) => !s)} accessibilityRole="button">
              <Txt variant="micro" color={colors.brand}>{show ? t('Hide password') : t('Show password')}</Txt>
            </Pressable>
          </View>

          <Button label={t('Sign in')} variant="primary" icon="arrowRight" loading={busy} onPress={() => void submit()} block />

          <Pressable onPress={() => setHelp((h) => !h)} accessibilityRole="button">
            <Row gap={6}>
              <Icon name="helpCircle" size={16} color={colors.brand} />
              <Txt variant="small" color={colors.brand} weight="semibold">{t('Need help signing in?')}</Txt>
            </Row>
          </Pressable>
          {help && (
            <Banner tone="info" icon="info">
              {t('Sign in with the email or mobile number registered with the school. Parents see only their own children; staff see the modules their role allows.')}
            </Banner>
          )}
        </View>

        <Row wrap gap={space.sm} style={{ justifyContent: 'center' }}>
          {AUDIENCES.map((a) => (
            <View key={a.label} style={styles.audience}>
              <Icon name={a.icon} size={14} color={colors.brand} />
              <Txt variant="micro" color={colors.brandStrong}>{t(a.label)}</Txt>
            </View>
          ))}
        </Row>
        <Txt variant="micro" center>{t('Your data is visible only to people whose role requires it.')}</Txt>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: space.lg, gap: space.lg, flexGrow: 1, maxWidth: 520, width: '100%', alignSelf: 'center' },
  langRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6 },
  langPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.brandLine, backgroundColor: colors.surface },
  langPillOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  brand: { alignItems: 'center', gap: 2, marginTop: space.sm },
  logo: { width: 128, height: 96, marginBottom: space.sm },
  card: {
    backgroundColor: colors.surface, borderRadius: 20, padding: space.xl - 4, gap: space.md, borderTopWidth: 4, borderTopColor: colors.accent,
    shadowColor: colors.brandStrong, shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 3,
  },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: 14,
    backgroundColor: colors.surface, minHeight: 50,
  },
  input: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 12 },
  audience: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.brandTint },
});
