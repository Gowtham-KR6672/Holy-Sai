/**
 * Mobile UI kit: brand typography (Montserrat / Noto Sans Tamil / Noto Sans Devanagari), cards, buttons,
 * badges, list rows, form fields, sheets and the loading / empty / error states every screen uses.
 */
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space, statusTone, toneColors, type Tone } from '@/theme/theme';
import { useI18n, type Weight } from '@/i18n/I18nProvider';
import { errorMessage } from '@/api/client';
import { fmt } from '@/lib/format';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
type Variant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'small' | 'micro' | 'eyebrow';
const VARIANTS: Record<Variant, { size: number; line: number; weight: Weight }> = {
  display: { size: 26, line: 34, weight: 'bold' },
  h1: { size: 21, line: 29, weight: 'bold' },
  h2: { size: 17, line: 24, weight: 'bold' },
  h3: { size: 15, line: 21, weight: 'semibold' },
  body: { size: 14, line: 20, weight: 'regular' },
  small: { size: 12.5, line: 18, weight: 'regular' },
  micro: { size: 11, line: 15, weight: 'medium' },
  eyebrow: { size: 11, line: 15, weight: 'bold' },
};

export function Txt({
  children, variant = 'body', weight, color, tone, center, numberOfLines, style, selectable,
}: {
  children?: ReactNode; variant?: Variant; weight?: Weight; color?: string; tone?: Tone; center?: boolean; numberOfLines?: number;
  style?: StyleProp<TextStyle>; selectable?: boolean;
}) {
  const { font, lang } = useI18n();
  const v = VARIANTS[variant];
  // Indic scripts need a little more line height.
  const extra = lang === 'en' ? 0 : Math.round(v.size * 0.35);
  return (
    <Text
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: font(weight ?? v.weight), fontSize: v.size, lineHeight: v.line + extra,
          color: color ?? (tone ? toneColors[tone].fg : variant === 'small' || variant === 'micro' ? colors.textMuted : colors.text),
        },
        variant === 'eyebrow' && { textTransform: 'uppercase', letterSpacing: 0.6, color: color ?? colors.textMuted },
        center && { textAlign: 'center' },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export function Screen({
  children, refreshing = false, onRefresh, padded = true, contentStyle,
}: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; padded?: boolean; contentStyle?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[padded && { padding: space.lg, gap: space.md }, { paddingBottom: insets.bottom + 32 }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} colors={[colors.brand]} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Row({ children, gap = space.sm, style, wrap }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, wrap && { flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function Col({ children, gap = space.sm, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

export function Divider() {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function Card({
  title, sub, icon, right, children, flush, style, onPress,
}: {
  title?: string; sub?: string; icon?: string; right?: ReactNode; children?: ReactNode; flush?: boolean; style?: StyleProp<ViewStyle>; onPress?: () => void;
}) {
  const body = (
    <>
      {(title || right) && (
        <View style={[styles.cardHead, flush && { paddingHorizontal: space.lg, paddingTop: space.lg }]}>
          {icon && (
            <View style={styles.cardIcon}>
              <Icon name={icon} size={16} color={colors.brand} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            {title && <Txt variant="h3">{title}</Txt>}
            {sub && <Txt variant="small">{sub}</Txt>}
          </View>
          {right}
        </View>
      )}
      {children}
    </>
  );
  const cardStyle = [styles.card, !flush && { padding: space.lg }, style];
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [...cardStyle, pressed && { opacity: 0.85 }]} accessibilityRole="button">
        {body}
      </Pressable>
    );
  }
  return <View style={cardStyle}>{body}</View>;
}

export function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <Row style={{ justifyContent: 'space-between', marginTop: space.sm }}>
      <Txt variant="eyebrow">{children}</Txt>
      {right}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold' | 'success';

export function Button({
  label, onPress, variant = 'secondary', icon, loading, disabled, size = 'md', block, style, accessibilityLabel,
}: {
  label: string; onPress?: () => void; variant?: ButtonVariant; icon?: string; loading?: boolean; disabled?: boolean; size?: 'sm' | 'md';
  block?: boolean; style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const v = BUTTONS[variant];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [
        styles.btn,
        size === 'sm' ? styles.btnSm : styles.btnMd,
        { backgroundColor: v.bg, borderColor: v.border },
        block && { alignSelf: 'stretch' },
        off && { opacity: 0.5 },
        pressed && !off && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={v.fg} /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} color={v.fg} /> : null}
      <Txt variant={size === 'sm' ? 'small' : 'body'} weight="semibold" color={v.fg}>{label}</Txt>
    </Pressable>
  );
}

const BUTTONS: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.brand, fg: colors.textInvert, border: colors.brand },
  secondary: { bg: colors.surface, fg: colors.text, border: colors.borderStrong },
  ghost: { bg: 'transparent', fg: colors.brand, border: 'transparent' },
  danger: { bg: colors.critical, fg: colors.textInvert, border: colors.critical },
  gold: { bg: colors.accent, fg: colors.brandStrong, border: colors.accent },
  success: { bg: colors.success, fg: colors.textInvert, border: colors.success },
};

export function IconButton({ icon, onPress, label, color = colors.text, size = 22 }: { icon: string; onPress: () => void; label: string; color?: string; size?: number }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={10} style={({ pressed }) => [{ padding: 6 }, pressed && { opacity: 0.6 }]}>
      <Icon name={icon} size={size} color={color} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Badges, avatars
// ---------------------------------------------------------------------------
export function Badge({ label, tone = 'neutral', dot, icon }: { label: string; tone?: Tone; dot?: boolean; icon?: string }) {
  const c = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      {dot && <View style={[styles.dot, { backgroundColor: c.solid }]} />}
      {icon && <Icon name={icon} size={12} color={c.fg} />}
      <Txt variant="micro" color={c.fg} numberOfLines={1}>{label}</Txt>
    </View>
  );
}

/** A status word from the API, translated and coloured like the web Status badge. */
export function StatusBadge({ value, tone }: { value: string | null | undefined; tone?: Tone }) {
  const { t } = useI18n();
  if (!value) return null;
  return <Badge label={t(value)} tone={tone ?? statusTone(value)} dot />;
}

export function Avatar({ name, size = 40, tone = 'brand' }: { name: string; size?: number; tone?: Tone }) {
  const c = toneColors[tone];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Txt variant={size >= 56 ? 'h2' : 'small'} weight="bold" color={c.fg}>{fmt.initials(name) || '?'}</Txt>
    </View>
  );
}

// ---------------------------------------------------------------------------
// List rows
// ---------------------------------------------------------------------------
export function ListItem({
  icon, tone, lead, title, meta, right, onPress, chevron, numberOfLines = 2,
}: {
  icon?: string; tone?: Tone; lead?: ReactNode; title: ReactNode; meta?: ReactNode; right?: ReactNode; onPress?: () => void; chevron?: boolean;
  numberOfLines?: number;
}) {
  const c = toneColors[tone ?? 'neutral'];
  const body = (
    <>
      {lead ?? (icon ? (
        <View style={[styles.itemIcon, { backgroundColor: tone ? c.bg : colors.bgSunken }]}>
          <Icon name={icon} size={17} color={tone ? c.solid : colors.textMuted} />
        </View>
      ) : null)}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? <Txt variant="body" weight="semibold" numberOfLines={numberOfLines}>{title}</Txt> : title}
        {meta ? (typeof meta === 'string' ? <Txt variant="small" numberOfLines={numberOfLines}>{meta}</Txt> : meta) : null}
      </View>
      {right}
      {(chevron ?? !!onPress) && !right && <Icon name="chevronRight" size={16} color={colors.textFaint} />}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.bgSunken }]}>
        {body}
      </Pressable>
    );
  }
  return <View style={styles.item}>{body}</View>;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function Loading({ label, height = 160 }: { label?: string; height?: number }) {
  const { t } = useI18n();
  return (
    <View style={{ minHeight: height, alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
      <ActivityIndicator color={colors.brand} />
      <Txt variant="small">{label ?? t('Loading…')}</Txt>
    </View>
  );
}

export function Empty({ icon = 'info', title, sub, action }: { icon?: string; title: string; sub?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={24} color={colors.brand} />
      </View>
      <Txt variant="h3" center>{title}</Txt>
      {sub && <Txt variant="small" center>{sub}</Txt>}
      {action}
    </View>
  );
}

/** Friendly error panel. Endpoints that are not built yet (404/501/503) read as "not available yet". */
export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const { t } = useI18n();
  const status = (error as { status?: number } | null)?.status;
  const unavailable = status === 404 || status === 501 || status === 503;
  const forbidden = status === 403;
  const heading = title ?? (unavailable ? t('Not available yet') : forbidden ? t('You do not have access to this') : t('Something went wrong'));
  const sub = unavailable
    ? t('This part of the school system is still being set up. Please check again later.')
    : forbidden
      ? t('Your role does not include this information. Contact the school office if you need it.')
      : t(errorMessage(error));
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: unavailable ? colors.accentTint : colors.criticalTint }]}>
        <Icon name={unavailable ? 'clock' : forbidden ? 'lock' : 'alert'} size={24} color={unavailable ? colors.accentStrong : colors.critical} />
      </View>
      <Txt variant="h3" center>{heading}</Txt>
      <Txt variant="small" center>{sub}</Txt>
      {onRetry && <Button label={t('Try again')} icon="refresh" size="sm" onPress={onRetry} />}
    </View>
  );
}

export function Banner({ tone = 'neutral', icon = 'info', children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  const c = toneColors[tone];
  return (
    <View style={[styles.banner, { backgroundColor: c.bg }]}>
      <Icon name={icon} size={18} color={c.solid} />
      <View style={{ flex: 1 }}>{typeof children === 'string' ? <Txt variant="small" color={c.fg}>{children}</Txt> : children}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------
export function Kpi({ label, value, foot, tone, icon, onPress }: { label: string; value: string | number; foot?: string; tone?: Tone; icon?: string; onPress?: () => void }) {
  const c = tone ? toneColors[tone] : null;
  const inner = (
    <>
      <Row gap={6}>
        {icon && <Icon name={icon} size={14} color={c?.solid ?? colors.textMuted} />}
        <Txt variant="micro" numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
      </Row>
      <Txt variant="h1" color={c?.solid ?? colors.text} numberOfLines={1}>{String(value)}</Txt>
      {foot ? <Txt variant="micro" numberOfLines={2}>{foot}</Txt> : null}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.kpi, pressed && { opacity: 0.8 }]} accessibilityRole="button">{inner}</Pressable>
  ) : (
    <View style={styles.kpi}>{inner}</View>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <View style={styles.kpiGrid}>{children}</View>;
}

export function Meter({ label, value, right, tone = 'brand' }: { label: string; value: number; right?: string; tone?: Tone }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <View style={{ gap: 4 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Txt variant="small" color={colors.text} numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
        {right && <Txt variant="small" weight="semibold" color={colors.text}>{right}</Txt>}
      </Row>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${pct}%`, backgroundColor: toneColors[tone].solid }]} />
      </View>
    </View>
  );
}

/** Simple bar trend (attendance by month and similar), drawn with views. */
export function MiniBars({ points, unit = '%', max = 100 }: { points: { label: string; value: number }[]; unit?: string; max?: number }) {
  if (!points.length) return null;
  const top = Math.max(max, ...points.map((p) => p.value));
  return (
    <View style={styles.bars}>
      {points.map((p, i) => (
        <View key={`${p.label}-${i}`} style={styles.barCol}>
          <Txt variant="micro" color={colors.text}>{`${Math.round(p.value)}${unit}`}</Txt>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { height: `${Math.max(4, (p.value / top) * 100)}%`, backgroundColor: p.value < 85 && unit === '%' ? colors.warning : colors.brand }]} />
          </View>
          <Txt variant="micro" numberOfLines={1}>{p.label}</Txt>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
export function Field({
  label, error, hint, required, style, ...input
}: TextInputProps & { label: string; error?: string; hint?: string; required?: boolean; style?: StyleProp<ViewStyle> }) {
  const { font } = useI18n();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[{ gap: 6 }, style]}>
      <Txt variant="small" weight="semibold" color={colors.text}>{label}{required ? ' *' : ''}</Txt>
      <TextInput
        placeholderTextColor={colors.textFaint}
        {...input}
        onFocus={(e) => { setFocused(true); input.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); input.onBlur?.(e); }}
        style={[
          styles.input,
          { fontFamily: font('regular') },
          input.multiline && { minHeight: 96, textAlignVertical: 'top', paddingTop: 12 },
          focused && { borderColor: colors.brand },
          !!error && { borderColor: colors.critical },
        ]}
        accessibilityLabel={label}
      />
      {error ? <Txt variant="micro" color={colors.critical}>{error}</Txt> : hint ? <Txt variant="micro">{hint}</Txt> : null}
    </View>
  );
}

export function Segmented<T extends string>({ items, value, onChange }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segment} accessibilityRole="tablist">
      {items.map((it) => {
        const on = it.id === value;
        return (
          <Pressable key={it.id} onPress={() => onChange(it.id)} style={[styles.segItem, on && styles.segOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <Txt variant="small" weight={on ? 'bold' : 'medium'} color={on ? colors.brand : colors.textMuted} numberOfLines={1}>{it.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chips<T extends string>({ items, value, onChange }: { items: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }}>
      {items.map((it) => {
        const on = it.id === value;
        return (
          <Pressable key={it.id} onPress={() => onChange(it.id)} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Txt variant="small" weight="semibold" color={on ? colors.textInvert : colors.text}>
              {it.label}{it.count != null ? ` · ${it.count}` : ''}
            </Txt>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Bottom sheet used for forms and details. */
export function Sheet({
  visible, onClose, title, sub, children, footer,
}: { visible: boolean; onClose: () => void; title: string; sub?: string; children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('Close')} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={styles.grabber} />
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Txt variant="h2">{title}</Txt>
              {sub && <Txt variant="small">{sub}</Txt>}
            </View>
            <IconButton icon="x" label={t('Close')} onPress={onClose} />
          </Row>
          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: space.md, paddingVertical: space.md }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer && <Row gap={space.sm} style={{ justifyContent: 'flex-end' }}>{footer}</Row>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A select field that opens a sheet of options. */
export function Select({
  label, value, options, onChange, placeholder, error, required,
}: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; placeholder?: string; error?: string; required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const current = options.find((o) => o.value === value);
  return (
    <View style={{ gap: 6 }}>
      <Txt variant="small" weight="semibold" color={colors.text}>{label}{required ? ' *' : ''}</Txt>
      <Pressable onPress={() => setOpen(true)} style={[styles.input, styles.select, !!error && { borderColor: colors.critical }]} accessibilityRole="button" accessibilityLabel={label}>
        <Txt variant="body" color={current ? colors.text : colors.textFaint} numberOfLines={1} style={{ flex: 1 }}>{current?.label ?? placeholder ?? t('Choose…')}</Txt>
        <Icon name="chevronDown" size={16} color={colors.textMuted} />
      </Pressable>
      {error ? <Txt variant="micro" color={colors.critical}>{error}</Txt> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        {options.length === 0 && <Txt variant="small">{t('No options available.')}</Txt>}
        {options.map((o) => (
          <ListItem key={o.value} title={o.label} onPress={() => { onChange(o.value); setOpen(false); }}
            right={o.value === value ? <Icon name="check" size={18} color={colors.brand} /> : undefined} chevron={false} />
        ))}
      </Sheet>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog (Alert on phones, window.confirm on the web smoke build)
// ---------------------------------------------------------------------------
export function confirmAction(opts: { title: string; body?: string; confirmLabel: string; cancelLabel: string; danger?: boolean }): Promise<boolean> {
  if (Platform.OS === 'web') {
    const w = globalThis as unknown as { confirm?: (m: string) => boolean };
    return Promise.resolve(w.confirm ? w.confirm(`${opts.title}${opts.body ? `\n\n${opts.body}` : ''}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(opts.title, opts.body, [
      { text: opts.cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      { text: opts.confirmLabel, style: opts.danger ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: space.md,
    shadowColor: '#4A0A22', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md, borderWidth: 1 },
  btnMd: { minHeight: 46, paddingHorizontal: 18 },
  btnSm: { minHeight: 36, paddingHorizontal: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 10, minHeight: 52 },
  itemIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl, paddingHorizontal: space.lg },
  emptyIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  banner: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: 'flex-start' },
  kpi: {
    flexGrow: 1, flexBasis: '46%', backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md, gap: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  meterTrack: { height: 8, borderRadius: 4, backgroundColor: colors.bgSunken, overflow: 'hidden' },
  meterFill: { height: 8, borderRadius: 4 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 150 },
  barCol: { flex: 1, alignItems: 'center', gap: 4, height: '100%' },
  barTrack: { flex: 1, width: '70%', justifyContent: 'flex-end', backgroundColor: colors.bgSunken, borderRadius: 6, overflow: 'hidden' },
  barFill: { width: '100%', borderRadius: 6 },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 15,
    color: colors.text, backgroundColor: colors.surface,
  },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  segment: { flexDirection: 'row', backgroundColor: colors.bgSunken, borderRadius: radius.md, padding: 3 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 10 },
  segOn: { backgroundColor: colors.surface, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: space.sm },
});
