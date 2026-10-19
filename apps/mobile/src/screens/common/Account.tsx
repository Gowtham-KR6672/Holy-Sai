import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ApiError, api, errorMessage } from '@/api/client';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { Avatar, Badge, Banner, Button, Card, Col, confirmAction, Divider, Field, Row, Screen, Txt } from '@/components/ui';
import { API_URL } from '@/lib/config';
import { colors, radius, space } from '@/theme/theme';
import Constants from 'expo-constants';

/** My account: profile details, language, change password (POST /auth/change-password) and sign out. */
export default function AccountScreen() {
  const user = useUser();
  const { signOut } = useAuth();
  const { t, lang, langs, setLang } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [pwOpen, setPwOpen] = useState(params.tab === 'password' || !!user.mustChangePassword);
  const [revoking, setRevoking] = useState(false);

  const doSignOut = async () => {
    const ok = await confirmAction({ title: t('Sign out?'), body: t('You will need your password to sign in again on this device.'), confirmLabel: t('Sign out'), cancelLabel: t('Cancel') });
    if (!ok) return;
    await signOut();
    router.replace('/sign-in');
  };

  const revokeAll = async () => {
    const ok = await confirmAction({
      title: t('Sign out everywhere?'), body: t('Every device, including this one, will need to sign in again.'),
      confirmLabel: t('Sign out everywhere'), cancelLabel: t('Cancel'), danger: true,
    });
    if (!ok) return;
    setRevoking(true);
    try {
      await api.post('/auth/sessions/revoke-all');
      toast(t('Signed out of every device'), 'success');
      await signOut();
      router.replace('/sign-in');
    } catch (err) {
      toast(t(errorMessage(err)), 'critical');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Screen>
      <Card>
        <Row gap={space.md}>
          <Avatar name={user.fullName} size={60} tone="caution" />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="h2">{user.fullName}</Txt>
            <Txt variant="small">{user.title || t(user.role.name)}</Txt>
            <Badge label={t(user.role.name)} tone="brand" />
          </View>
        </Row>
        <Divider />
        <Col gap={6}>
          <Detail label={t('Email')} value={user.email} />
          {user.phone ? <Detail label={t('Mobile')} value={user.phone} /> : null}
          <Detail label={t('Campus')} value={user.campus_name ?? '—'} />
          <Detail label={t('Academic year')} value={user.academic_year ?? '—'} />
          <Detail label={t('Permissions')} value={t('{n} granted by your role', { n: user.permissions.length })} />
        </Col>
        <Txt variant="micro">{t('To correct your name or contact details, contact the school office — changes to identity records are verified.')}</Txt>
      </Card>

      <Card title={t('Language')} icon="globe" sub={t('Every screen switches immediately.')}>
        <View style={styles.langs}>
          {langs.map((l) => {
            const on = l.id === lang;
            return (
              <Pressable key={l.id} onPress={() => setLang(l.id)} style={[styles.lang, on && styles.langOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                <Txt variant="body" weight="semibold" color={on ? colors.textInvert : colors.text}>{l.label}</Txt>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <Card title={t('Change password')} icon="lock" sub={t('You will be signed out of every device after the change.')}
        right={!pwOpen ? <Button size="sm" label={t('Change')} onPress={() => setPwOpen(true)} /> : undefined}>
        {user.mustChangePassword && <Banner tone="warning" icon="alert">{t('Please choose a new password before you continue.')}</Banner>}
        {pwOpen && <PasswordForm onDone={async () => { await signOut(); router.replace('/sign-in'); }} />}
      </Card>

      <Card title={t('Privacy and access')} icon="shield">
        <Txt variant="small">{t('Your data is visible only to people whose role requires it. Views of sensitive records — including student locations — are recorded in the audit trail.')}</Txt>
        <Button label={t('Sign out of all devices')} icon="logout" variant="secondary" onPress={() => void revokeAll()} loading={revoking} />
      </Card>

      <Button label={t('Sign out')} icon="logout" variant="danger" onPress={() => void doSignOut()} block />
      <Txt variant="micro" center>{`Holy Sai Smart School 360 · v${Constants.expoConfig?.version ?? '1.0.0'} · ${API_URL}`}</Txt>
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }} gap={space.md}>
      <Txt variant="small">{label}</Txt>
      <Txt variant="small" weight="semibold" color={colors.text} style={{ flexShrink: 1, textAlign: 'right' }}>{value}</Txt>
    </Row>
  );
}

function PasswordForm({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const [v, setV] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    const x: Record<string, string> = {};
    if (!v.current) x.current = t('Enter your current password');
    if (v.next.length < 10 || !/[a-z]/.test(v.next) || !/[A-Z]/.test(v.next) || !/[0-9]/.test(v.next)) x.next = t('At least 10 characters with upper case, lower case and a number');
    if (v.next !== v.confirm) x.confirm = t('Passwords do not match');
    setErr(x);
    setFormError(null);
    if (Object.keys(x).length) return;
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: v.current, newPassword: v.next });
      toast(t('Password changed — please sign in again'), 'success');
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        const f = e.fieldErrors;
        setErr({ current: f.currentPassword ? t(f.currentPassword) : '', next: f.newPassword ? t(f.newPassword) : '' });
      } else setFormError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Col gap={space.md}>
      {formError && <Banner tone="critical" icon="alert">{formError}</Banner>}
      <Field label={t('Current password')} secureTextEntry autoCapitalize="none" autoComplete="current-password" value={v.current} onChangeText={(x) => setV({ ...v, current: x })} error={err.current || undefined} required />
      <Field label={t('New password')} secureTextEntry autoCapitalize="none" autoComplete="new-password" value={v.next} onChangeText={(x) => setV({ ...v, next: x })}
        error={err.next || undefined} hint={t('At least 10 characters, with upper case, lower case and a number.')} required />
      <Field label={t('Confirm new password')} secureTextEntry autoCapitalize="none" autoComplete="new-password" value={v.confirm} onChangeText={(x) => setV({ ...v, confirm: x })} error={err.confirm || undefined} required />
      <Button label={t('Change password')} icon="lock" variant="primary" onPress={() => void submit()} loading={busy} />
    </Col>
  );
}

const styles = StyleSheet.create({
  langs: { flexDirection: 'row', gap: space.sm },
  lang: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  langOn: { backgroundColor: colors.brand, borderColor: colors.brand },
});
