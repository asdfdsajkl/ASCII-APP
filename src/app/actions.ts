'use server';

import { generateImageFromPrompt } from '@/ai/flows/generate-image-from-prompt';

/**
 * Server Action that orchestrates prompt submission and AI image generation.
 * Validates input, propagates compact mode, and returns data URI or error message.
 */
export async function generateImageAction(
  prevState: { imageDataUri: string | null; error: string | null; prompt?: string | null },
  formData: FormData
): Promise<{ imageDataUri: string | null; error: string | null; prompt?: string | null }> {
  const prompt = formData.get('prompt') as string;
  const compactMode = formData.get('compactMode') === 'true';

  if (!prompt) {
    return { imageDataUri: null, error: 'Prompt cannot be empty.' };
  }

  try {
    const result = await generateImageFromPrompt({ promptText: prompt, compactMode });
    if (!result?.imageDataUri) {
      return { imageDataUri: null, error: 'Failed to generate image. The AI model did not return an image.' };
    }
    return { imageDataUri: result.imageDataUri, error: null, prompt: prompt };
  } catch (e) {
    console.error(e);
    const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred while generating the image.';
    return { imageDataUri: null, error: `AI error: ${errorMessage}` };
  }
}
