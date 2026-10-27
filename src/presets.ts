export const PRESET_IDS = ['explain', 'eli5', 'deeper'] as const
export type BranchPreset = typeof PRESET_IDS[number]
export const BRANCH_PRESETS: Record<BranchPreset, { label: string; question: string }> = {
  explain: { label: 'Explain', question: '请解释这段内容。' },
  eli5: { label: 'ELI5', question: '请像给五岁孩子讲解一样，用简单的语言和例子解释这段内容。' },
  deeper: { label: 'Go deeper', question: '请围绕这段内容进一步深入说明。' },
}

/** Legacy records predate the creation tag; use their original prompt, never a renamed title. */
export function creationPreset(operation: { preset?: BranchPreset | 'custom'; question: string }): BranchPreset | undefined {
  if (operation.preset === 'custom') return undefined
  return operation.preset ?? PRESET_IDS.find(id => BRANCH_PRESETS[id].question === operation.question)
}
