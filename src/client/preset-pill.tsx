import { BRANCH_PRESETS } from '../presets.ts'
import type { BranchPreset } from '../presets.ts'

export function PresetPill({ preset }: { preset?: BranchPreset }) {
  if (!preset) return null
  return <span className="pc-preset-pill" data-preset={preset} title={`通过 ${BRANCH_PRESETS[preset].label} 创建的分支`}>{BRANCH_PRESETS[preset].label}</span>
}
