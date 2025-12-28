import { GoogleGenerativeAI } from "@google/generative-ai";
import { LOGIC_MODEL, TTS_MODEL } from "../constants";
import { DubSegment } from "../types";

// Helper para pegar o cliente com a chave correta (Adaptado para Vite)
const getClient = (apiKey?: string) => {
  // @ts-ignore
  const envKey = import.meta.env?.VITE_API_KEY;
  const key = (apiKey && apiKey.trim().length > 0) ? apiKey : envKey;
  
  if (!key) {
    throw new Error("API Key is missing. Please provide a key in the settings or check your environment configuration.");
  }
  return new GoogleGenerativeAI(key);
};

// Retry helper for Rate Limiting (429) - Mantido igual ao original
async function retryOperation<T>(
  operation: () => Promise<T>, 
  maxRetries: number = 3, 
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const msg = error?.message || '';
      const status = error?.status || error?.response?.status;
      const isRateLimit = status === 429 || status === 503 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      
      if (!isRateLimit) {
        throw error; 
      }

      const delay = baseDelay * Math.pow(2, i);
      console.warn(`Gemini API Rate Limit hit. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// 1. Transcription Helper - SEUS PROMPTS ORIGINAIS RESTAURADOS
export const transcribeAudio = async (
  audioBase64: string,
  mimeType: string,
  sourceLang: string,
  apiKey?: string
): Promise<Omit<DubSegment, 'audioBuffer' | 'translatedText'>[]> => {
  const genAI = getClient(apiKey);
  // Configuramos para retornar JSON direto
  const model = genAI.getGenerativeModel({ 
    model: LOGIC_MODEL,
    generationConfig: { responseMimeType: "application/json" }
  });
  
  // PROMPT ORIGINAL MANTIDO
  const prompt = `
    You are a professional transcriber. 
    Analyze the provided audio file. 
    Identify distinct speech segments.
    Language is ${sourceLang}.
    Return a JSON array where each object has:
    - "id": number (sequence)
    - "start": number (start time in seconds, precise to 2 decimals)
    - "end": number (end time in seconds, precise to 2 decimals)
    - "originalText": string (the transcribed text)
    
    Ensure strict timestamp accuracy. Ignore background noise or music.
  `;

  return retryOperation(async () => {
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: mimeType,
            data: audioBase64
          }
        }
      ]);

      const response = await result.response;
      const text = response.text();
      
      // Limpeza básica caso o modelo retorne markdown
      const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(jsonStr);
      
      return data.map((item: any) => ({
        id: item.id,
        start: item.start,
        end: item.end,
        originalText: item.originalText,
        duration: item.end - item.start
      }));
  });
};

// 2. Batch Translation Helper - SEUS PROMPTS ORIGINAIS RESTAURADOS
export const translateAllSegments = async (
  segments: DubSegment[],
  sourceLang: string,
  targetLang: string,
  apiKey?: string
): Promise<{ id: number; translatedText: string }[]> => {
  const genAI = getClient(apiKey);
  const model = genAI.getGenerativeModel({ 
    model: LOGIC_MODEL,
    generationConfig: { responseMimeType: "application/json" }
  });
  
  // Send duration to model so it can respect timing
  const simplifiedSegments = segments.map(s => ({
    id: s.id,
    text: s.originalText,
    durationSeconds: parseFloat((s.end - s.start).toFixed(2))
  }));

  // PROMPT ORIGINAL MANTIDO
  const prompt = `
    You are an expert Dubbing Scriptwriter and Translator.
    Translate the following dialogue from ${sourceLang} to ${targetLang}.

    CRITICAL INSTRUCTIONS:
    1. **Global Context**: Read the entire conversation first. Ensure terms are consistent. (e.g., if "rice flour" is mentioned in segment 5, don't just say "cleaned" in segment 4 if the context implies the method used. Fix context gaps).
    2. **Strict Isochrony (Timing)**: Each segment has a 'durationSeconds'. You MUST fit your translation into that time.
       - If the literal translation is too long, **condense** or **rewrite** it to convey the meaning in fewer syllables.
       - If the literal translation is too short, expand it slightly to match the lip-flap/timing naturally.
       - **Do not** exceed the time limit. Overlapping audio is a failure.
    3. **Natural Flow**: The result must sound like a natural conversation in ${targetLang}, not a robotic translation.

    Input Data:
    ${JSON.stringify(simplifiedSegments)}

    Output Requirement:
    Return a JSON array of objects with 'id' and 'translatedText'.
  `;

  return retryOperation(async () => {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  });
};

// 3. TTS Generation Helper
// Mantemos a versão fetch manual para garantir que o áudio funcione sem erros de tipo da biblioteca
export const generateSpeech = async (
  text: string,
  voiceName: string,
  langCode: string,
  apiKey?: string
): Promise<string | null> => {
  
  // @ts-ignore
  const envKey = import.meta.env?.VITE_API_KEY;
  const key = (apiKey && apiKey.trim().length > 0) ? apiKey : envKey;

  // Endpoint REST direto para evitar erros da SDK no browser
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`;
  
  const payload = {
    contents: { parts: [{ text: text }] },
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName }
        }
      }
    }
  };

  const callApi = async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
       const err = await response.text();
       throw new Error(`TTS Error: ${response.status} - ${err}`);
    }
    
    const data = await response.json();
    const base64Audio = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("API returned no audio data.");
    return base64Audio;
  };

  try {
    return await retryOperation(callApi, 5, 2000);
  } catch (error) {
    console.error("TTS Generation Error (Final):", error);
    return null;
  }
};
