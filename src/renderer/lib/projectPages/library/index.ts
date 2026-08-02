import { PAGE_HOME } from './homeSlots';
import { PAGE_MARKETING } from './marketingSlots';
import { PAGE_FEATURE } from './featureSlots';
import { PAGE_ARCH } from './architectureSlots';
import type { PageLensDef, SlotDef, VariantDef, PresetDef } from './types';

export type { PageLensDef, SlotDef, VariantDef, PresetDef };

export type LensId = 'home' | 'marketing' | 'feature' | 'architecture';

export const LENS_LIBRARY: Record<LensId, PageLensDef> = {
  home: PAGE_HOME,
  marketing: PAGE_MARKETING,
  feature: PAGE_FEATURE,
  architecture: PAGE_ARCH,
};

export const LENS_ORDER: LensId[] = ['home', 'marketing', 'feature', 'architecture'];
