import { VoiceOption } from "./types";

export const VOICE_OPTIONS: VoiceOption[] = [
  { name: 'Kore', id: 'Kore', gender: 'Female' },
  { name: 'Puck', id: 'Puck', gender: 'Male' },
  { name: 'Fenrir', id: 'Fenrir', gender: 'Male' },
  { name: 'Charon', id: 'Charon', gender: 'Male' },
  { name: 'Aoede', id: 'Aoede', gender: 'Female' },
];

export const LANGUAGES = [
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'en-US', name: 'English (US)' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
  { code: 'ja-JP', name: 'Japanese' },
];

export const LOGIC_MODEL = 'gemini-2.5-flash'; // Atualizado para o modelo mais rápido
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';   // O TTS agora pode usar o mesmo modelo em alguns casos, ou mantenha o preview
