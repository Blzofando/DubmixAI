import React from 'react';
import { ProcessingStatus } from '../types';

interface ProcessingQueueProps {
  status: ProcessingStatus;
  progress: number;
  currentTask?: string;
}

const ProcessingQueue: React.FC<ProcessingQueueProps> = ({ status, progress, currentTask }) => {
  if (status === ProcessingStatus.IDLE || status === ProcessingStatus.READY || status === ProcessingStatus.ERROR) {
    return null;
  }

  const getStatusLabel = () => {
    switch(status) {
      case ProcessingStatus.UPLOADING: return 'Analysing Audio File...';
      case ProcessingStatus.TRANSCRIBING: return 'Transcribing Audio with Gemini AI...';
      case ProcessingStatus.TRANSLATING: return 'Translating Context (Isochronic)...';
      case ProcessingStatus.GENERATING_AUDIO: return 'Synthesizing Voices (TTS)...';
      default: return 'Processing...';
    }
  };

  return (
    <div className="mt-8 p-6 bg-slate-800 rounded-xl border border-slate-700 animate-pulse">
      <div className="flex items-center justify-between mb-2">
        <span className="text-cyan-400 font-semibold text-sm uppercase tracking-wider">{getStatusLabel()}</span>
        <span className="text-slate-400 text-xs font-mono">{Math.round(progress)}%</span>
      </div>
      <div className="w-full bg-slate-900 rounded-full h-2.5 overflow-hidden">
        <div 
          className="bg-gradient-to-r from-cyan-500 to-blue-600 h-2.5 rounded-full transition-all duration-500" 
          style={{ width: `${progress}%` }}
        ></div>
      </div>
      {currentTask && (
        <p className="mt-2 text-xs text-slate-500 truncate font-mono">
          &gt; {currentTask}
        </p>
      )}
    </div>
  );
};

export default ProcessingQueue;