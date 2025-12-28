export class AudioService {
  private audioContext: AudioContext;

  constructor() {
    // Mantém compatibilidade com todos os navegadores
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }

  get context() {
    return this.audioContext;
  }

  async decodeFile(file: File): Promise<AudioBuffer> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bufferCopy = arrayBuffer.slice(0);
      return await this.audioContext.decodeAudioData(bufferCopy);
    } catch (error: any) {
      console.error("Audio decoding failed:", error);
      throw error;
    }
  }

  async decodeBase64(base64Data: string): Promise<AudioBuffer> {
    try {
      const binaryString = window.atob(base64Data.replace(/\s/g, ''));
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      try {
        const pcmBuffer = this.rawPcmToAudioBuffer(bytes.buffer, 24000);
        return this.trimSilence(pcmBuffer);
      } catch (pcmError) {
        const bufferCopy = bytes.buffer.slice(0);
        const decoded = await this.audioContext.decodeAudioData(bufferCopy);
        return this.trimSilence(decoded);
      }
    } catch (error: any) {
      console.error("Audio conversion failed:", error);
      throw new Error(`Failed to decode generated audio.`);
    }
  }

  trimSilence(buffer: AudioBuffer): AudioBuffer {
    const data = buffer.getChannelData(0);
    const len = data.length;
    let start = 0;
    let end = len;
    const threshold = 0.005;

    while (start < len && Math.abs(data[start]) < threshold) start++;
    while (end > start && Math.abs(data[end - 1]) < threshold) end--;

    if (start >= end) return buffer;

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
    const audioBuffer = this.audioContext.createBuffer(1, dataInt16.length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < dataInt16.length; i++) {
      channelData[i] = dataInt16[i] / 32768.0;
    }
    return audioBuffer;
  }

  /**
   * ALGORITMO OLA (Overlap-Add) SIMPLIFICADO
   * Estica ou encolhe o áudio sem alterar o tom (Pitch).
   * speed > 1.0 = mais rápido (encolhe)
   * speed < 1.0 = mais lento (estica)
   */
  private timeStretch(buffer: AudioBuffer, speed: number): AudioBuffer {
    if (speed === 1.0) return buffer;

    const numChannels = buffer.numberOfChannels;
    const oldData = buffer.getChannelData(0); // Processamos Mono para performance (dublagem geralmente é mono)
    const newLength = Math.floor(oldData.length / speed);
    
    // Criamos o buffer final
    const newBuffer = this.audioContext.createBuffer(numChannels, newLength, buffer.sampleRate);
    const newData = newBuffer.getChannelData(0);

    // Configurações do algoritmo (Janela de 50ms aprox)
    const windowSize = 1024; 
    const overlap = windowSize / 2; // 50% overlap
    
    // Posições de leitura e escrita
    let analysisPtr = 0;
    let synthesisPtr = 0;

    while (synthesisPtr + windowSize < newLength && analysisPtr + windowSize < oldData.length) {
      // Copiar janela com cross-fade simples (triangular)
      for (let i = 0; i < windowSize; i++) {
        const grain = oldData[Math.floor(analysisPtr) + i];
        
        // Janela de Hanning (suavização para evitar cliques)
        const envelope = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
        
        // Como estamos sobrepondo, somamos ao que já existe no buffer
        if (synthesisPtr + i < newLength) {
             // OLA simples: Na prática, para mudar velocidade, mudamos o passo de análise
             // Aqui fazemos uma implementação simplificada: apenas copiamos o grão
             // Mas a "mágica" é onde colocamos o synthesisPtr vs analysisPtr
             
             // Nota: Implementar OLA perfeito do zero em JS puro é complexo.
             // Vamos usar uma interpolação linear simples que funciona melhor que drop-sample
             // Se o speed for muito alto, isso ainda pode degradar, mas não muda o tom.
        }
      }
      
      // Avançamos os ponteiros
      synthesisPtr += overlap;
      analysisPtr += overlap * speed; // A mágica está aqui: lemos mais rápido ou mais devagar
    }

    // --- PLANO B: SOLUÇÃO GRANULAR NAIVE (Mais robusta para fala) ---
    // O loop acima é teórico. Abaixo, a implementação prática que funciona:
    
    const grainSize = 2048;
    const grainSpacing = Math.floor(grainSize * speed); // Pulo baseado na velocidade
    let outPos = 0;
    let inPos = 0;

    // Preenchemos com zeros primeiro
    newData.fill(0);

    while (inPos + grainSize < oldData.length && outPos + grainSize < newLength) {
        for (let i = 0; i < grainSize; i++) {
            // Janela triangular simples para misturar o inicio e fim do grão
            let weight = 1 - Math.abs((i - grainSize / 2) / (grainSize / 2));
            newData[outPos + i] += oldData[inPos + i] * weight;
        }
        
        // Normalização aproximada para compensar a sobreposição (Overlap 50% fixo na saída)
        // Na verdade, avançamos o output fixo, e o input variável
        outPos += grainSize / 2; 
        inPos += Math.floor((grainSize / 2) * speed);
    }
    
    // Normalizar volume final (hack simples para evitar clip)
    // O método granular naive pode aumentar ganho, vamos reduzir levemente
    for(let i=0; i<newData.length; i++) {
        newData[i] = newData[i] * 0.8; 
    }

    return newBuffer;
  }

  async exportMix(
    originalBuffer: AudioBuffer,
    segments: { startTime: number; endTime: number; audioBuffer: AudioBuffer | null }[],
    backgroundVolume: number = 0.0
  ): Promise<Blob> {
    let totalDuration = originalBuffer.duration;
    segments.forEach(seg => {
        if(seg.endTime > totalDuration) totalDuration = seg.endTime;
    });

    const OfflineContext = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const offlineCtx = new OfflineContext(
      2, 
      totalDuration * originalBuffer.sampleRate,
      originalBuffer.sampleRate
    );

    // Background
    if (backgroundVolume > 0) {
        const bgSource = offlineCtx.createBufferSource();
        bgSource.buffer = originalBuffer;
        const bgGain = offlineCtx.createGain();
        bgGain.gain.value = backgroundVolume;
        bgSource.connect(bgGain);
        bgGain.connect(offlineCtx.destination);
        bgSource.start(0);
    }

    // Dubs
    for (const seg of segments) {
      if (seg.audioBuffer) {
        const source = offlineCtx.createBufferSource();
        
        const slotDuration = seg.endTime - seg.startTime;
        const originalDuration = seg.audioBuffer.duration;
        
        let processedBuffer = seg.audioBuffer;

        // Se precisar ajustar o tempo, processamos MANUALMENTE agora
        if (Math.abs(originalDuration - slotDuration) > 0.05) { // Só mexe se diferença > 50ms
            const rate = originalDuration / slotDuration;
            // AQUI É A MUDANÇA: Chamamos nossa função matemática
            // Ela devolve um buffer novo já no tamanho certo e no tom certo
            processedBuffer = this.timeStretch(seg.audioBuffer, rate);
            
            // Como já esticamos o buffer, tocamos ele em velocidade normal (1.0)
            source.playbackRate.value = 1.0; 
        } else {
            source.playbackRate.value = 1.0;
        }

        source.buffer = processedBuffer;
        source.connect(offlineCtx.destination);
        source.start(seg.startTime);
      }
    }

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

    function setUint16(data: number) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data: number) { view.setUint32(pos, data, true); pos += 4; }

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

    for (i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));

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
