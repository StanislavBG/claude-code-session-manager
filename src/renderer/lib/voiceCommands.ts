export interface VoiceCommand {
  match: RegExp
  data: string
  label: string
}

export const VOICE_COMMANDS: VoiceCommand[] = [
  { match: /^(send|submit|enter)\.?$/i, data: '\r', label: 'send' },
  { match: /^(cancel|escape)\.?$/i, data: '\x1b', label: 'cancel' },
  { match: /^clear( line)?\.?$/i, data: '\x15', label: 'clear' },
]

export function matchVoiceCommand(text: string): VoiceCommand | null {
  const t = text.trim()
  return VOICE_COMMANDS.find((c) => c.match.test(t)) ?? null
}
