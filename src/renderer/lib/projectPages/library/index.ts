import { PAGE_HOME } from './homeSlots';
import { PAGE_MARKETING } from './marketingSlots';
import { PAGE_FEATURE } from './featureSlots';
import { PAGE_ARCH } from './architectureSlots';
import { PAGE_BRIEF } from './briefSlots';
import type { PageLensDef, SlotDef, VariantDef, PresetDef } from './types';

export type { PageLensDef, SlotDef, VariantDef, PresetDef };

export type LensId = 'home' | 'marketing' | 'feature' | 'architecture' | 'brief';

export const LENS_LIBRARY: Record<LensId, PageLensDef> = {
  home: PAGE_HOME,
  marketing: PAGE_MARKETING,
  feature: PAGE_FEATURE,
  architecture: PAGE_ARCH,
  brief: PAGE_BRIEF,
};

// 'brief' sits last: it's the generated form of the old React Brief blocks,
// the least "pitch"-flavored lens, and the newest addition — home/marketing/
// feature/architecture keep their existing order untouched.
export const LENS_ORDER: LensId[] = ['home', 'marketing', 'feature', 'architecture', 'brief'];
