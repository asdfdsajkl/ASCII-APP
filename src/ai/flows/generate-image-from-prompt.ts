
'use server';

/**
 * @fileOverview This file defines a Genkit flow for generating images from a text prompt.
 *
 * It includes:
 * - `generateImageFromPrompt`: An async function that takes a text prompt and returns a data URI of the generated image.
 * - `GenerateImageFromPromptInput`: The input type for the `generateImageFromPrompt` function, which is a text prompt.
 * - `GenerateImageFromPromptOutput`: The output type for the `generateImageFromfrompt` function, which is a data URI representing the generated image.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const GenerateImageFromPromptInputSchema = z.object({
  promptText: z.string().describe('The text prompt to generate an image from.'),
  compactMode: z.boolean().optional().describe('Whether to generate an image optimized for compact ASCII art.'),
});
export type GenerateImageFromPromptInput = z.infer<typeof GenerateImageFromPromptInputSchema>;

const GenerateImageFromPromptOutputSchema = z.object({
  imageDataUri: z
    .string()
    .describe(
      'The generated image as a data URI that must include a MIME type and use Base64 encoding. Expected format: \'data:<mimetype>;base64,<encoded_data>\'.' // Corrected data URI description
    ),
});
export type GenerateImageFromPromptOutput = z.infer<typeof GenerateImageFromPromptOutputSchema>;

export async function generateImageFromPrompt(
  input: GenerateImageFromPromptInput
): Promise<GenerateImageFromPromptOutput> {
  return generateImageFromPromptFlow(input);
}

const generateImageFromPromptFlow = ai.defineFlow(
  {
    name: 'generateImageFromPromptFlow',
    inputSchema: GenerateImageFromPromptInputSchema,
    outputSchema: GenerateImageFromPromptOutputSchema,
  },
  async input => {
    // Build a prompt tailored for ASCII conversion. Compact Mode enforces
    // strict, high-contrast, black-background guidance to maximize clarity.
    let fullPrompt: string;

    if (input.compactMode) {
      fullPrompt = `Generate a artistic, black and white image of: "${input.promptText}".

This image is for a special Braille art conversion, so clarity and high contrast are essential.

**CRITICAL STYLE GUIDELINES:**
- **HIGH-CONTRAST MONOCHROME:** Use strong lighting and deep shadows to create a clear separation between the subject and the background. The result should feel more like a graphic illustration than a photograph.
- **SOLID BLACK BACKGROUND:** The background must be a solid, non-textured, pure black.
- **CLEAR, FOCUSED SUBJECT:** The main subject must be well-defined and be the primary focus.
- **NO TEXT or BORDERS:** The image must not contain any text, letters, or frames.

**Think:** "graphic illustration", "stencil art", "woodcut print", "high-contrast", "subject on plain black background".

**NEGATIVE PROMPTS (what to strictly avoid):**
- "color, photorealistic, low contrast, complex background, scenery, textured background, text, words, letters, border, frame".`;
    } else {
      fullPrompt = `Generate an image of a "${input.promptText}".

      **Key Principles for Good ASCII Conversion:**
      - **High Contrast:** Strong separation between subject and background.
      - **Simple Background:** Solid colors are better than busy textures.
      - **Clear Subject:** The main subject should be well-defined.
      
      **Prompt Ideas:** 
      - "high-contrast portrait, black background, rim light, monochrome, minimalist"
      - "silhouette scene, stark contrast, minimalism, clean composition"

      **Negative Prompts (what to avoid):** "border, frame"`;
    }

    // Generate image using Imagen Fast model; result exposes a data URI via media.url.
    const {media} = await ai.generate({
      model: 'googleai/imagen-4.0-fast-generate-001',
      prompt: fullPrompt,
    });

    if (!media) {
      throw new Error('No image was generated.');
    }

    // Return a base64 data URI (e.g., 'data:image/png;base64,...').
    return {imageDataUri: media.url};
  }
);
