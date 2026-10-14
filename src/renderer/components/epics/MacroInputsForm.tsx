/**
 * MacroInputsForm — the small inline form a HOT KEYS macro with declared inputs opens
 * instead of launching on click. Prefilled from each input's default, so a macro whose
 * inputs all have defaults is one press plus Enter. Validation is `renderMacroPrompt`'s,
 * the same check the launch path runs — an error shows inline and nothing is submitted.
 */
import { useState } from 'react'
import type { Macro } from '../../../preload/api'
import { MACRO_INPUT_MAX_LEN, defaultMacroValues, renderMacroPrompt } from '../../lib/macroPrompt'

const FIELD =
  'rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none focus:border-accent'

export interface MacroInputsFormProps {
  macro: Macro
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}

export function MacroInputsForm({ macro, onSubmit, onCancel }: MacroInputsFormProps) {
  const inputs = macro.inputs ?? []
  const [values, setValues] = useState<Record<string, string>>(() => defaultMacroValues(inputs))
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      data-testid="macro-inputs-form"
      noValidate
      className="flex flex-col gap-2 rounded-lg border border-line bg-bg-hi p-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        const r = renderMacroPrompt(macro.prompt, inputs, values)
        if (!r.ok) {
          setError(r.error)
          return
        }
        setError(null)
        onSubmit(values)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="text-[11.5px] font-semibold text-fg">{macro.label}</div>
      {inputs.map((i, idx) => (
        <label key={i.name} className="flex flex-col gap-1 text-[11.5px] text-fg-dim">
          <span>
            {i.label}
            {i.required && <span className="text-red-500" title="Required"> *</span>}
          </span>
          {i.options && i.options.length > 0 ? (
            <select
              data-testid={`macro-input-${i.name}`}
              className={FIELD}
              value={values[i.name] ?? ''}
              autoFocus={idx === 0}
              onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
            >
              {!i.required && <option value="" />}
              {i.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              data-testid={`macro-input-${i.name}`}
              className={FIELD}
              value={values[i.name] ?? ''}
              maxLength={MACRO_INPUT_MAX_LEN}
              required={i.required}
              autoFocus={idx === 0}
              onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
            />
          )}
        </label>
      ))}
      {error && (
        <div data-testid="macro-inputs-error" role="alert" className="text-[11.5px] text-red-500">
          {error}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          data-testid="macro-inputs-start"
          className="inline-flex items-center rounded-md border border-transparent bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white"
        >
          Start
        </button>
        <button
          type="button"
          data-testid="macro-inputs-cancel"
          onClick={onCancel}
          className="inline-flex items-center rounded-md border border-line bg-bg px-2.5 py-1 text-[11.5px] font-semibold text-fg-dim hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
