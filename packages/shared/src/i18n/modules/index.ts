// Register each module's translation file here.
import { foundation } from './foundation';
import { mobile } from './mobile';

export interface ModuleTranslations {
  ta: Record<string, string>;
  hi: Record<string, string>;
}

export const MODULE_TRANSLATIONS: ModuleTranslations[] = [foundation, mobile];
