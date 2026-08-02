import type { ComponentType } from 'react';
import type { ProjectPageSummary } from '../summaryType';

export interface VariantDef {
  id: string;
  label: string;
  note: string;
  component: ComponentType<{ summary: ProjectPageSummary }>;
}

export interface SlotDef {
  id: string;
  label: string;
  variants: VariantDef[];
}

export interface PresetDef {
  id: string;
  label: string;
  note: string;
  pick: Record<string, string>;
}

export interface PageLensDef {
  id: string;
  label: string;
  blurb: string;
  slots: SlotDef[];
  presets: PresetDef[];
}
