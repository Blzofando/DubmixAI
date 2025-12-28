export interface VoiceOption {
  name: string;
  id: string;
  gender: string;
}

export interface DubSegment {
  id: number;
  start: number;
  end: number;
  originalText: string;
  translatedText?: string;
  audioBuffer?: AudioBuffer | null;
  duration?: number;
}

export enum ProcessingStatus {
  IDLE = 'IDLE',
  UPLOADING = 'UPLOADING',
  TRANSCRIBING = 'TRANSCRIBING',
  TRANSCRIBED = 'TRANSCRIBED',
  TRANSLATING = 'TRANSLATING',
  TRANSLATED = 'TRANSLATED',
  GENERATING_AUDIO = 'GENERATING_AUDIO',
  READY = 'READY',
  ERROR = 'ERROR'
}

export interface ProjectState {
  file: File | null;
  originalBuffer: AudioBuffer | null;
  segments: DubSegment[];
  status: ProcessingStatus;
  progress: number;
  error: string | null;
  sourceLang: string;
  targetLang: string;
  selectedVoice: string;
  customApiKey: string;
}
