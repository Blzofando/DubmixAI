export class AudioService {
  private audioContext: AudioContext;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }

  get context() {
    return this.audioContext;
  }

  async decodeFile(file: File): Promise<AudioBuffer> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      // Clone buffer to prevent detachment issues
      const bufferCopy = arrayBuffer.slice(0);
      return await this.audioContext.decodeAudioData(bufferCopy);
    } catch (error: any) {
      console.error("Audio decoding failed:", error);
      if (error.name === 'EncodingError' || error.message?.includes('Decoding failed')) {
         throw new Error(`Browser could not decode this file. Try converting to a standard MP3 or WAV.`);
      }
      throw error;
    }
  }

  /**
   * Decodes Base64 audio. 
   * specifically handles Raw PCM (Int16, 24kHz) which is what Gemini TTS returns.
   */
  async decodeBase64(base64Data: string): Promise<AudioBuffer> {
    try {
      // 1. Decode Base64 string to binary
      const binaryString = window.atob(base64Data.replace(/\s/g, ''));
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 2. Try to decode as Raw PCM (16-bit, 24kHz Mono - Gemini Standard)
      try {
        const pcmBuffer = this.rawPcmToAudioBuffer(bytes.buffer, 24000);
        return this.trimSilence(pcmBuffer);
      } catch (pcmError) {
        // Fallback
        const bufferCopy = bytes.buffer.slice(0);
        const decoded = await this.audioContext.decodeAudioData(bufferCopy);
        return this.trimSilence(decoded);
      }

    } catch (error: any) {
      console.error("Audio conversion failed:", error);
      throw new Error(`Failed to decode generated audio. The TTS output was invalid.`);
    }
  }

  trimSilence(buffer: AudioBuffer): AudioBuffer {
    const data = buffer.getChannelData(0);
    const len = data.length;
    let start = 0;
    let end = len;
    const threshold = 0.005;

    while (start < len && Math.abs(data[start]) < threshold) {
      start++;
    }

    while (end > start && Math.abs(data[end - 1]) < threshold) {
      end--;
    }

    if (start >= end) {
      return buffer;
    }

    const newLen = end - start;
    const newBuffer = this.audioContext.createBuffer(buffer.numberOfChannels, newLen, buffer.sampleRate);
    
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const oldData = buffer.getChannelData(channel);
      const newData = newBuffer.getChannelData(channel);
      for (let i = 0; i < newLen; i++) {
        newData[i] = oldData[start + i];
      }
    }

    return newBuffer;
  }

  private rawPcmToAudioBuffer(arrayBuffer: ArrayBuffer, sampleRate: number): AudioBuffer {
    const dataInt16 = new Int16Array(arrayBuffer);
    const numChannels = 1;
    const frameCount = dataInt16.length;
    
    const audioBuffer = this.audioContext.createBuffer(numChannels, frameCount, sampleRate);
    
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i] / 32768.0;
    }

    return audioBuffer;
  }

  // --- AQUI ESTAVA O PROBLEMA ---
  async exportMix(
    originalBuffer: AudioBuffer,
    segments: { startTime: number; endTime: number; audioBuffer: AudioBuffer | null }[],
    backgroundVolume: number = 0.0
  ): Promise<Blob> {
    let totalDuration = originalBuffer.duration;
    segments.forEach(seg => {
        if(seg.endTime > totalDuration) totalDuration = seg.endTime;
    });

    // FIX 1: Compatibilidade com iOS/WebKit (iPhone)
    const OfflineContext = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const offlineCtx = new OfflineContext(
      2, 
      totalDuration * originalBuffer.sampleRate,
      originalBuffer.sampleRate
    );

    // Background Track
    if (backgroundVolume > 0) {
        const bgSource = offlineCtx.createBufferSource();
        bgSource.buffer = originalBuffer;
        const bgGain = offlineCtx.createGain();
        bgGain.gain.value = backgroundVolume;
        bgSource.connect(bgGain);
        bgGain.connect(offlineCtx.destination);
        bgSource.start(0);
    }

    // Dubbed Segments
    segments.forEach((seg) => {
      if (seg.audioBuffer) {
        const source = offlineCtx.createBufferSource();
        
        // FIX 2: Definir preservesPitch ANTES de tudo para garantir
        (source as any).preservesPitch = true;
        (source as any).webkitPreservesPitch = true; // Forçar em WebKits antigos

        const slotDuration = seg.endTime - seg.startTime;
        const originalDuration = seg.audioBuffer.duration;
        let rate = 1.0;
        
        if (originalDuration > slotDuration) {
            rate = originalDuration / slotDuration;
        }

        source.playbackRate.value = rate;
        source.buffer = seg.audioBuffer;
        
        source.connect(offlineCtx.destination);
        source.start(seg.startTime);
      }
    });

    const renderedBuffer = await offlineCtx.startRendering();
    return this.bufferToWave(renderedBuffer, renderedBuffer.length);
  }

  private bufferToWave(abuffer: AudioBuffer, len: number): Blob {
    let numOfChan = abuffer.numberOfChannels,
      length = len * numOfChan * 2 + 44,
      buffer = new ArrayBuffer(length),
      view = new DataView(buffer),
      channels = [],
      i,
      sample,
      offset = 0,
      pos = 0;

    function setUint16(data: number) {
      view.setUint16(pos, data, true);
      pos += 2;
    }

    function setUint32(data: number) {
      view.setUint32(pos, data, true);
      pos += 4;
    }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); 
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); 
    setUint16(1); 
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); 
    setUint16(numOfChan * 2); 
    setUint16(16); 

    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); 

    for (i = 0; i < abuffer.numberOfChannels; i++)
      channels.push(abuffer.getChannelData(i));

    while (pos < len) {
      for (i = 0; i < numOfChan; i++) {
        sample = Math.max(-1, Math.min(1, channels[i][pos]));
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
        view.setInt16(44 + offset, sample, true);
        offset += 2;
      }
      pos++;
    }

    return new Blob([buffer], { type: "audio/wav" });
  }
}

export const audioService = new AudioService();
