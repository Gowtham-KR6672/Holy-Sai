import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/i18n/I18nProvider';
import { addDays, fmt } from '@/lib/format';
import { colors, radius, space } from '@/theme/theme';
import { IconButton, Txt } from './ui';

/** A date picker without native dependencies: step a YYYY-MM-DD date by a day (or a week with a long list of days). */
export function DateStepper({
  label, value, onChange, min, max, error,
}: { label: string; value: string; onChange: (v: string) => void; min?: string; max?: string; error?: string }) {
  const { t } = useI18n();
  const canBack = !min || addDays(value, -1) >= min;
  const canFwd = !max || addDays(value, 1) <= max;
  return (
    <View style={{ gap: 6 }}>
      <Txt variant="small" weight="semibold" color={colors.text}>{label}</Txt>
      <View style={[styles.box, !!error && { borderColor: colors.critical }]}>
        <IconButton icon="chevronsLeft" label={t('A week earlier')} color={canBack ? colors.brand : colors.border} onPress={() => { const n = addDays(value, -7); if (!min || n >= min) onChange(n); }} size={18} />
        <IconButton icon="chevronLeft" label={t('Previous day')} color={canBack ? colors.brand : colors.border} onPress={() => canBack && onChange(addDays(value, -1))} size={20} />
        <Txt variant="body" weight="semibold" style={{ flex: 1, textAlign: 'center' }}>{fmt.date(value)}</Txt>
        <IconButton icon="chevronRight" label={t('Next day')} color={canFwd ? colors.brand : colors.border} onPress={() => canFwd && onChange(addDays(value, 1))} size={20} />
        <IconButton icon="chevronRight" label={t('A week later')} color={canFwd ? colors.brand : colors.border} onPress={() => { const n = addDays(value, 7); if (!max || n <= max) onChange(n); }} size={14} />
      </View>
      {error ? <Txt variant="micro" color={colors.critical}>{error}</Txt> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    minHeight: 48, paddingHorizontal: 4, backgroundColor: colors.surface,
  },
});
