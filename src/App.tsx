import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ProjectState, ProcessingStatus, DubSegment, VoiceOption } from './types'; // Sem .ts
import { VOICE_OPTIONS, LANGUAGES } from './constants'; // Sem .ts
import { audioService } from './services/audioService'; // Sem .ts
import * as geminiService from './services/geminiService'; // Sem .ts
import Waveform from './components/Waveform'; // Sem .tsx
import ProcessingQueue from './components/ProcessingQueue'; // Sem .tsx
import { Upload, Play, Pause, Download, Volume2, Mic, FileAudio, RefreshCw, Wand2, Type, Languages, Music, KeyRound, Check } from 'lucide-react';



const INITIAL_STATE: ProjectState = {
  file: null,
  originalBuffer: null,
  segments: [],
  status: ProcessingStatus.IDLE,
  progress: 0,
  error: null,
  sourceLang: 'en-US',
  targetLang: 'pt-BR',
  selectedVoice: 'Puck', // Default male voice
  customApiKey: '',
};

// Simple helper to sleep for Rate Limiting backoff
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const getGeminiCompatibleMimeType = (file: File): string => {
  const ext = file.name.split('.').pop()?.toLowerCase();
  
  if (ext === 'mp3') return 'audio/mp3';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4'; 
  if (ext === 'mp4') return 'audio/mp4';
  if (ext === 'mov') return 'video/mov';
  if (ext === 'mpeg' || ext === 'mpg') return 'audio/mpeg';
  
  return file.type || 'audio/mp3';
};

const App: React.FC = () => {
  const [state, setState] = useState<ProjectState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentTaskLabel, setCurrentTaskLabel] = useState<string>("");
  
  // Local state for API Key input
  const [tempApiKey, setTempApiKey] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);

  // Refs for audio playback
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const ttsNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);

  useEffect(() => {
    audioContextRef.current = audioService.context;
    return () => stopAudio();
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setState(prev => ({ ...prev, status: ProcessingStatus.UPLOADING, file, error: null, progress: 10 }));
      
      const buffer = await audioService.decodeFile(file);
      setState(prev => ({ 
        ...prev, 
        originalBuffer: buffer, 
        status: ProcessingStatus.IDLE,
        progress: 0,
        segments: [] // Reset segments on new file
      }));
    } catch (err: any) {
      console.error(err);
      const msg = err.message || "Failed to load audio file. Please try a standard MP3/WAV.";
      setState(prev => ({ ...prev, status: ProcessingStatus.ERROR, error: msg }));
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleSaveApiKey = () => {
    setState(prev => ({ ...prev, customApiKey: tempApiKey }));
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  };

  // --- Step 1: Transcribe ---
  const handleTranscribe = async () => {
    if (!state.file || !state.originalBuffer) return;

    try {
      setState(prev => ({ ...prev, status: ProcessingStatus.TRANSCRIBING, progress: 10, error: null }));
      const base64Audio = await fileToBase64(state.file);
      const mimeType = getGeminiCompatibleMimeType(state.file);
      
      const rawSegments = await geminiService.transcribeAudio(
        base64Audio, 
        mimeType, 
        state.sourceLang,
        state.customApiKey
      );
      
      const segments: DubSegment[] = rawSegments.map(s => ({
        ...s,
        translatedText: '',
        audioBuffer: s.audioBuffer || null
      })) as DubSegment[];

      setState(prev => ({ 
        ...prev, 
        status: ProcessingStatus.TRANSCRIBED, 
        segments, 
        progress: 100 
      }));

    } catch (err: any) {
      console.error(err);
      setState(prev => ({ ...prev, status: ProcessingStatus.ERROR, error: err.message || "Transcription failed." }));
    }
  };

  // --- Step 2: Translate (Batch Optimized) ---
  const handleTranslate = async () => {
    try {
        setState(prev => ({ ...prev, status: ProcessingStatus.TRANSLATING, progress: 20, error: null }));
        setCurrentTaskLabel("Translating full transcript with context...");

        const translatedSegments = await geminiService.translateAllSegments(
            state.segments,
            state.sourceLang,
            state.targetLang,
            state.customApiKey
        );

        // Merge translations back into state
        const updatedSegments = state.segments.map(seg => {
            const translation = translatedSegments.find(t => t.id === seg.id);
            return {
                ...seg,
                translatedText: translation ? translation.translatedText : seg.originalText
            };
        });

        setState(prev => ({ 
            ...prev, 
            segments: updatedSegments, 
            status: ProcessingStatus.TRANSLATED, 
            progress: 100, 
            currentTaskLabel: "" 
        }));

    } catch (err: any) {
        console.error(err);
        setState(prev => ({ ...prev, status: ProcessingStatus.ERROR, error: err.message || "Translation failed." }));
    }
  };

  // --- Step 3: Generate Dub (TTS) ---
  const handleDubbing = async () => {
    try {
        setState(prev => ({ ...prev, status: ProcessingStatus.GENERATING_AUDIO, progress: 0, error: null }));
        const updatedSegments = [...state.segments];
        const total = updatedSegments.length;

        for (let i = 0; i < total; i++) {
            const seg = updatedSegments[i];
            // Only generate if we have a translation and haven't generated yet (or want to regenerate)
            if (seg.translatedText) {
                setCurrentTaskLabel(`Dubbing: "${seg.translatedText.substring(0, 20)}..."`);
                
                const voiceId = state.selectedVoice;
                const audioB64 = await geminiService.generateSpeech(
                    seg.translatedText, 
                    voiceId, 
                    state.targetLang,
                    state.customApiKey
                );
                
                if (audioB64) {
                    const buffer = await audioService.decodeBase64(audioB64);
                    updatedSegments[i].audioBuffer = buffer;
                }
            }
            setState(prev => ({ ...prev, segments: [...updatedSegments], progress: (i + 1) / total * 100 }));
            await sleep(1000); // Rate limiting for TTS - Increased to 1000ms
        }

        setState(prev => ({ 
            ...prev, 
            segments: updatedSegments, 
            status: ProcessingStatus.READY, 
            progress: 100, 
            currentTaskLabel: "" 
        }));

    } catch (err: any) {
        console.error(err);
        setState(prev => ({ ...prev, status: ProcessingStatus.ERROR, error: err.message || "Dubbing failed." }));
    }
  };


  const stopAudio = useCallback(() => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch(e) {}
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    
    ttsNodesRef.current.forEach(node => {
      try { node.stop(); } catch(e) {}
      node.disconnect();
    });
    ttsNodesRef.current = [];

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setIsPlaying(false);
  }, []);

  const playAudio = async (startOffset = 0) => {
    if (!audioContextRef.current || !state.originalBuffer) return;

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    stopAudio();

    const ctx = audioContextRef.current;
    startTimeRef.current = ctx.currentTime - startOffset;

    // 1. Play Background (Muted - Reference Track)
    const bgSource = ctx.createBufferSource();
    bgSource.buffer = state.originalBuffer;
    const bgGain = ctx.createGain();
    bgGain.gain.value = 0.0; // MUTED
    bgSource.connect(bgGain);
    bgGain.connect(ctx.destination);
    
    bgSource.start(0, startOffset);
    sourceNodeRef.current = bgSource;

    // 2. Play Dubbed Segments
    state.segments.forEach(seg => {
        if (!seg.audioBuffer) return;
        
        const segEnd = seg.end;
        if (segEnd < startOffset) return; // Completely passed

        const source = ctx.createBufferSource();
        source.buffer = seg.audioBuffer;
        
        // --- TIME COMPRESSION LOGIC ---
        // Ensure the audio fits STRICTLY within (seg.end - seg.start)
        const slotDuration = seg.end - seg.start;
        const audioDuration = seg.audioBuffer.duration;
        let playbackRate = 1.0;

        if (audioDuration > slotDuration) {
            // Speed up to fit
            playbackRate = audioDuration / slotDuration;
        }
        source.playbackRate.value = playbackRate;
        // IMPORTANT: Enable pitch preservation for live preview as well
        (source as any).preservesPitch = true;
        // -----------------------------

        source.connect(ctx.destination);

        // Logic:
        // Global Time: startTimeRef.current
        // Segment Start Absolute Time: startTimeRef.current + seg.start
        
        if (seg.start < startOffset) {
            // Seeked into middle
            // Need to adjust offset for playbackRate
            const realTimeOffset = startOffset - seg.start;
            const sampleOffset = realTimeOffset * playbackRate; 
            
            source.start(ctx.currentTime, sampleOffset);
        } else {
            // Future segment
            source.start(startTimeRef.current + seg.start);
        }
        
        ttsNodesRef.current.push(source);
    });

    setIsPlaying(true);

    const updateUI = () => {
        const now = ctx.currentTime;
        const elapsed = now - startTimeRef.current;
        if (elapsed >= (state.originalBuffer?.duration || 0)) {
            setIsPlaying(false);
            setCurrentTime(0);
            return;
        }
        setCurrentTime(elapsed);
        animationFrameRef.current = requestAnimationFrame(updateUI);
    };
    updateUI();
  };

  const handleExport = async () => {
    if (!state.originalBuffer) return;
    try {
        const blob = await audioService.exportMix(
            state.originalBuffer, 
            state.segments.map(s => ({ 
                startTime: s.start, 
                endTime: s.end,
                audioBuffer: s.audioBuffer || null
            }))
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dubmix_export_${Date.now()}.wav`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Export failed", e);
        alert("Export failed. See console.");
    }
  };

  const isProcessing = [
    ProcessingStatus.TRANSCRIBING, 
    ProcessingStatus.TRANSLATING, 
    ProcessingStatus.GENERATING_AUDIO
  ].includes(state.status);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 p-4 sticky top-0 z-50">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
              <Mic size={18} className="text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Dubmix <span className="text-indigo-400 text-xs font-normal bg-indigo-950 px-2 py-0.5 rounded-full border border-indigo-900">Beta</span></h1>
          </div>
          <div className="flex gap-4">
             <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-xs text-slate-400 hover:text-white underline">Billing Info</a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full p-4 md:p-8">
        
        {state.error && (
            <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-lg mb-6 flex items-center gap-3">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                {state.error}
            </div>
        )}

        <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="md:col-span-2 space-y-4">
                <div className={`
                    border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center transition-all cursor-pointer h-full min-h-[250px]
                    ${state.file ? 'border-indigo-500 bg-indigo-950/20' : 'border-slate-700 hover:border-slate-500 hover:bg-slate-900'}
                `}>
                    <input 
                        type="file" 
                        accept="audio/*,video/*,audio/mpeg,audio/wav,audio/mp4,audio/mp3,audio/x-m4a,.mp3,.wav,.m4a,.mp4,.mov,.mpeg,.mpg" 
                        onChange={handleFileUpload} 
                        className="hidden" 
                        id="audio-upload"
                        disabled={isProcessing}
                    />
                    <label htmlFor="audio-upload" className="w-full h-full flex flex-col items-center justify-center cursor-pointer">
                        {state.file ? (
                            <>
                                <FileAudio size={48} className="text-indigo-400 mb-4" />
                                <span className="text-lg font-medium text-white">{state.file.name}</span>
                                <span className="text-sm text-slate-400 mt-1">{(state.file.size / 1024 / 1024).toFixed(2)} MB</span>
                                <span className="text-xs text-slate-500 mt-2">Click to replace</span>
                            </>
                        ) : (
                            <>
                                <Upload size={48} className="text-slate-500 mb-4" />
                                <span className="text-lg font-medium text-slate-300">Upload Audio or Video</span>
                                <span className="text-sm text-slate-500 mt-1">Supports MP3, WAV, MP4, MOV</span>
                            </>
                        )}
                    </label>
                </div>
            </div>

            {/* Workflow Control Panel */}
            <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800 flex flex-col gap-4">
                
                {/* SETTINGS (Always visible but disabled during processing) */}
                <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Languages</label>
                    <div className="flex gap-2">
                        <select 
                            className="w-1/2 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-sm text-white outline-none"
                            value={state.sourceLang}
                            onChange={(e) => setState(prev => ({...prev, sourceLang: e.target.value}))}
                            disabled={state.status !== ProcessingStatus.IDLE && state.status !== ProcessingStatus.UPLOADING}
                        >
                            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                        </select>
                        <span className="flex items-center text-slate-600">→</span>
                        <select 
                            className="w-1/2 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-sm text-white outline-none"
                            value={state.targetLang}
                            onChange={(e) => setState(prev => ({...prev, targetLang: e.target.value}))}
                            disabled={isProcessing}
                        >
                            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                        </select>
                    </div>
                </div>

                <div className="pt-2 border-t border-slate-800">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Voice</label>
                    <div className="grid grid-cols-2 gap-2">
                        {VOICE_OPTIONS.map(v => (
                            <button
                                key={v.id}
                                onClick={() => setState(prev => ({...prev, selectedVoice: v.id}))}
                                disabled={isProcessing}
                                className={`
                                    px-2 py-1.5 rounded-md text-[10px] font-medium border transition-colors
                                    ${state.selectedVoice === v.id 
                                        ? 'bg-indigo-600 border-indigo-500 text-white' 
                                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'}
                                `}
                            >
                                {v.name}
                            </button>
                        ))}
                    </div>
                </div>

                {/* API Key Section */}
                <div className="pt-2 border-t border-slate-800">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <KeyRound size={12} /> API Key (Optional)
                    </label>
                    <div className="flex gap-2">
                        <input 
                            type="password" 
                            value={tempApiKey}
                            onChange={(e) => setTempApiKey(e.target.value)}
                            placeholder="Paste Gemini API Key"
                            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-white outline-none focus:border-indigo-500 transition-colors placeholder:text-slate-600"
                            disabled={isProcessing}
                        />
                        <button 
                            onClick={handleSaveApiKey}
                            className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center min-w-[40px]
                                ${apiKeySaved 
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50' 
                                    : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 hover:text-white'}
                            `}
                            disabled={isProcessing}
                            title="Save API Key"
                        >
                            {apiKeySaved ? <Check size={14} /> : 'OK'}
                        </button>
                    </div>
                    <p className="text-[10px] text-slate-600 mt-1.5 ml-1">
                        {state.customApiKey ? "Using provided custom key." : "Using system default key."}
                    </p>
                </div>

                <div className="mt-auto space-y-2">
                    {/* STEP 1: TRANSCRIBE */}
                    {state.status === ProcessingStatus.IDLE && state.file && (
                         <button 
                            onClick={handleTranscribe}
                            className="w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-indigo-500/20"
                        >
                            <Type size={18} /> Transcribe Audio
                        </button>
                    )}

                    {/* STEP 2: TRANSLATE */}
                    {(state.status === ProcessingStatus.TRANSCRIBED || state.status === ProcessingStatus.TRANSLATING) && (
                         <button 
                            onClick={handleTranslate}
                            disabled={state.status === ProcessingStatus.TRANSLATING}
                            className={`w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 
                                ${state.status === ProcessingStatus.TRANSLATING 
                                    ? 'bg-slate-700 text-slate-400 cursor-wait' 
                                    : 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-lg'}
                            `}
                        >
                            {state.status === ProcessingStatus.TRANSLATING ? <RefreshCw className="animate-spin" /> : <Languages size={18} />}
                            {state.status === ProcessingStatus.TRANSLATING ? 'Translating...' : 'Translate Text'}
                        </button>
                    )}

                    {/* STEP 3: DUB */}
                    {(state.status === ProcessingStatus.TRANSLATED || state.status === ProcessingStatus.GENERATING_AUDIO || state.status === ProcessingStatus.READY) && (
                         <button 
                            onClick={handleDubbing}
                            disabled={state.status === ProcessingStatus.GENERATING_AUDIO}
                            className={`w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 
                                ${state.status === ProcessingStatus.GENERATING_AUDIO 
                                    ? 'bg-slate-700 text-slate-400 cursor-wait' 
                                    : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white shadow-lg'}
                            `}
                        >
                            {state.status === ProcessingStatus.GENERATING_AUDIO ? <RefreshCw className="animate-spin" /> : <Music size={18} />}
                            {state.status === ProcessingStatus.GENERATING_AUDIO ? 'Dubbing...' : 'Generate Dub'}
                        </button>
                    )}

                    {isProcessing && state.status === ProcessingStatus.TRANSCRIBING && (
                         <button disabled className="w-full py-3 rounded-lg bg-slate-800 text-slate-400 font-bold flex items-center justify-center gap-2 cursor-wait">
                            <RefreshCw className="animate-spin" size={18} /> Transcribing...
                         </button>
                    )}
                </div>
            </div>
        </section>

        <ProcessingQueue status={state.status} progress={state.progress} currentTask={currentTaskLabel} />

        {/* 3. Studio / Result Section */}
        {state.originalBuffer && (
            <section className="mt-8 bg-slate-900 rounded-2xl border border-slate-800 p-6 shadow-xl">
                 <div className="flex items-center justify-between mb-6">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Volume2 size={20} className="text-indigo-400" />
                        Dubbing Studio
                    </h2>
                    <div className="flex gap-2">
                         <button 
                            onClick={() => isPlaying ? stopAudio() : playAudio(currentTime)}
                            className="flex items-center gap-2 px-4 py-2 bg-white text-slate-900 rounded-full font-bold hover:bg-slate-200 transition-colors"
                        >
                            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                            {isPlaying ? 'Pause' : 'Play Mix'}
                        </button>
                        {state.status === ProcessingStatus.READY && (
                            <button 
                                onClick={handleExport}
                                className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-indigo-400 border border-slate-700 rounded-full font-medium hover:bg-slate-750 transition-colors"
                            >
                                <Download size={18} />
                                Export WAV
                            </button>
                        )}
                    </div>
                </div>

                <Waveform 
                    duration={state.originalBuffer.duration} 
                    segments={state.segments}
                    currentTime={currentTime}
                    onSeek={(t) => {
                        setCurrentTime(t);
                        if(isPlaying) playAudio(t);
                    }}
                />

                <div className="mt-6 space-y-2">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Transcript & Translation</h3>
                    <div className="max-h-60 overflow-y-auto pr-2 space-y-2 custom-scrollbar">
                        {state.segments.length === 0 && <p className="text-slate-600 text-sm italic">
                            {state.status === ProcessingStatus.TRANSCRIBING ? "Listening..." : "Waiting for transcription..."}
                        </p>}
                        {state.segments.map(seg => (
                            <div key={seg.id} className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 rounded-lg bg-slate-950/50 border border-slate-800 text-sm">
                                <div>
                                    <span className="text-xs text-slate-500 font-mono mb-1 block">[{seg.start.toFixed(1)}s - {seg.end.toFixed(1)}s]</span>
                                    <p className="text-slate-300">{seg.originalText}</p>
                                </div>
                                <div className="border-t md:border-t-0 md:border-l border-slate-800 pt-2 md:pt-0 md:pl-4">
                                    <span className="text-xs text-indigo-400 font-mono mb-1 block flex items-center gap-2">
                                        Target 
                                        {seg.audioBuffer && <span className="w-2 h-2 rounded-full bg-green-500" title="Audio Generated"></span>}
                                    </span>
                                    {/* Editable textarea could be added here later */}
                                    <p className="text-indigo-100 min-h-[1.5em]">{seg.translatedText || <span className="text-slate-600 italic">Pending translation...</span>}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>
        )}
      </main>
    </div>
  );
};

export default App;