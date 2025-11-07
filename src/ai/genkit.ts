/**
 * Genkit configuration: registers Google GenAI plugin and selects default model.
 * Ensure environment variables required by `@genkit-ai/google-genai` are set
 * (API key and any project-specific options) before running the Next server.
 */
import {genkit} from 'genkit';
import {googleAI} from '@genkit-ai/google-genai';

export const ai = genkit({
  plugins: [googleAI()],
  model: 'googleai/gemini-2.5-flash',
});
