import React, { useMemo } from 'react';
import { DubSegment } from '../types';

interface WaveformProps {
  duration: number; // Total duration of original audio
  segments: DubSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
}

const Waveform: React.FC<WaveformProps> = ({ duration, segments, currentTime, onSeek }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    if (!containerRef.current || duration <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.min(Math.max(x / rect.width, 0), 1);
    onSeek(percentage * duration);
  };

  const progressPercent = useMemo(() => {
    if (duration <= 0) return 0;
    return Math.min((currentTime / duration) * 100, 100);
  }, [currentTime, duration]);

  return (
    <div className="w-full select-none" role="group" aria-label="Audio Timeline">
      <div 
        ref={containerRef}
        className="relative h-24 bg-slate-900 rounded-lg overflow-hidden cursor-pointer border border-slate-700 shadow-inner"
        onClick={handleClick}
      >
        {/* Time Grid Lines */}
        <div className="absolute inset-0 flex pointer-events-none opacity-20">
            {[...Array(10)].map((_, i) => (
                <div key={i} className="flex-1 border-r border-slate-500 last:border-0"></div>
            ))}
        </div>

        {/* Segments Visualization */}
        {segments.map((seg) => {
          const left = (seg.start / duration) * 100;
          const width = ((seg.end - seg.start) / duration) * 100;
          const hasAudio = !!seg.audioBuffer;

          return (
            <div
              key={seg.id}
              className={`absolute top-2 bottom-2 rounded-md border text-[10px] overflow-hidden flex items-center justify-center transition-colors
                ${hasAudio ? 'bg-indigo-600/40 border-indigo-400 text-indigo-100' : 'bg-slate-700/40 border-slate-600 text-slate-400'}
                hover:bg-indigo-500/50
              `}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`Original: ${seg.originalText}\nTranslated: ${seg.translatedText}`}
            >
             <span className="truncate px-1 hidden md:inline">{seg.translatedText || "Processing..."}</span>
            </div>
          );
        })}

        {/* Playhead */}
        <div 
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)] z-10 transition-all duration-75 linear"
            style={{ left: `${progressPercent}%` }}
        >
            <div className="w-3 h-3 bg-red-500 rounded-full -ml-[5px] mt-20 shadow-sm" />
        </div>
      </div>
      <div className="flex justify-between text-xs text-slate-400 mt-1">
        <span>00:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
};

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default Waveform;