"use client";

// AsciiWorld: client-side component for image sourcing and ASCII conversion.
// Upload or generate images, detect background, then map to
// ASCII or Braille characters with optional dithering/inversion for clarity.

import { useState, useRef, useEffect, ChangeEvent, startTransition } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Image from 'next/image';
import { Code, Image as ImageIcon, Wand2, Loader2, Copy, FileText, Bot, FileCode } from 'lucide-react';
import { generateImageAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { measureCharMetrics } from '@/lib/image-processing';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** Server Action state: data URI, errors, and prompt/file metadata. */
const initialState: { imageDataUri: string | null; error: string | null; prompt?: string | null; fileName?: string | null; } = {
  imageDataUri: null,
  error: null,
  prompt: null,
  fileName: null,
};

const characterSets = {
  standard: ['@', '%', '#', '*', '+', '=', '-', ':', '.', ' '],
  detailed: [...`$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^'. `],
  simple: ['#', '?', '%', '.', ' '],
  binary: ['1', '0', ' '],
  braille: [], // Braille is handled by a special function
};

/**
 * Convert grayscale buffer to Unicode Braille art.
 * Each Braille char represents a 2x4 pixel cell aligned to bbox.
 */
function generateBrailleArt(grayBuf: Uint8ClampedArray, width: number, height: number, bbox: {left: number, top: number, right: number, bottom: number}): string {
  let asciiArt = '';
  // Braille characters are 2x4 dots, so we process the image in 2x4 pixel blocks.
  // We adjust the bbox to be aligned with these blocks.
  const startY = Math.floor(bbox.top / 4) * 4;
  const endY = Math.ceil(bbox.bottom / 4) * 4;
  const startX = Math.floor(bbox.left / 2) * 2;
  const endX = Math.ceil(bbox.right / 2) * 2;

  for (let y = startY; y < endY; y += 4) {
      for (let x = startX; x < endX; x += 2) {
          // The 8 dots in a Braille character map to a 2x4 grid of pixels.
          // The mapping is a bit unusual, not linear.
          // Dots 1, 2, 3 are in the left column, 4, 5, 6 in the right.
          // Dot 7 is bottom-left, Dot 8 is bottom-right.
          // U+2800 is the base character (all dots off).
          // We add a value based on which dots are 'on'.
          //   (x,y) (x+1,y)       -> dot 1, dot 4
          // (x,y+1) (x+1,y+1)     -> dot 2, dot 5
          // (x,y+2) (x+1,y+2)     -> dot 3, dot 6
          // (x,y+3) (x+1,y+3)     -> dot 7, dot 8
          const dotMap = [1, 2, 3, 7, 4, 5, 6, 8];
          let brailleCode = 0x2800;
          let dotIndex = 0;

          for (let col = 0; col < 2; col++) {
              for (let row = 0; row < 4; row++) {
                  const px = x + col;
                  const py = y + row;
                  if (px < width && py < height) {
                      const brightness = grayBuf[py * width + px];
                      // If the pixel is more than 50% bright, turn the dot on.
                      if (brightness > 127) {
                          brailleCode |= (1 << (dotMap[dotIndex] - 1));
                      }
                  }
                  dotIndex++;
              }
          }
          asciiArt += String.fromCharCode(brailleCode);
      }
      asciiArt += '\n';
  }
  return asciiArt;
}


/** Prompt submit button; shows pending spinner state. */
function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Generating...
        </>
      ) : (
        <>
          <Wand2 className="mr-2 h-4 w-4" />
          Generate
        </>
      )}
    </Button>
  );
}

/**
 * Main UI orchestrating image sourcing (upload/AI), conversion pipeline, and controls.
 */
export function AsciiWorld() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [isAiGenerated, setIsAiGenerated] = useState<boolean>(false);
  const [sourceInfo, setSourceInfo] = useState<{ type: 'ai' | 'upload', value: string } | null>(null);

  const [asciiArt, setAsciiArt] = useState<string>('');
  const [detail, setDetail] = useState(120); // This will now act as 'cols'
  const [invertColors, setInvertColors] = useState<boolean>(true);
  const [charSetName, setCharSetName] = useState<keyof typeof characterSets>('standard');
  const [gamma, setGamma] = useState(1.0);
  const [dithering, setDithering] = useState(true);
  const [compactMode, setCompactMode] = useState(false);
  const [preprocess, setPreprocess] = useState(false);
  const [preprocessStrength, setPreprocessStrength] = useState(0);
  // Simplified preprocessing: no "simplicity" adjustment
  const [generationCount, setGenerationCount] = useState(0); // Add generation counter
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const asciiContainerRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const debounceRef = useRef<number | null>(null);

  const { toast } = useToast();

  const [generateState, formAction] = useActionState(generateImageAction, initialState);

  useEffect(() => {
    if (generateState.imageDataUri) {
      setImageSrc(generateState.imageDataUri);
      setIsAiGenerated(true);
      if (generateState.prompt) {
        setSourceInfo({ type: 'ai', value: generateState.prompt });
      }
    }
    if (generateState.error) {
      toast({
        variant: 'destructive',
        title: 'Image Generation Failed',
        description: generateState.error,
      });
    }
  }, [generateState, toast]);

  // Revoke blob URL on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      if (imageSrc && imageSrc.startsWith('blob:')) {
        try { URL.revokeObjectURL(imageSrc); } catch {}
      }
    };
  }, [imageSrc]);

    useEffect(() => {
        if (compactMode) {
            setCharSetName('braille');
            setDetail(60);
            setInvertColors(false);
        } else {
            setCharSetName('standard');
            setDetail(120);
            setInvertColors(true);
        }
    }, [compactMode]);


  // Initialize Web Worker once and handle messages
  useEffect(() => {
    const w = new Worker(new URL('../workers/asciiPipeline.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const { ascii } = e.data as { ascii: string };
      startTransition(() => setAsciiArt(ascii));
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // Segmentation worker removed; pipeline runs without optional masks

  // Core conversion effect: decode → scale → send ImageData to worker (debounced)
  useEffect(() => {
    if (!imageSrc || !canvasRef.current || !workerRef.current) return;

    const run = async () => {
      const canvas = canvasRef.current!;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;

      const asciiOutputElement = asciiContainerRef.current;
      if (!asciiOutputElement) return;

      let charWidth = 8;
      let charHeight = 16;
      const isBraille = charSetName === 'braille';

      try {
        const fontSizePx = parseFloat(getComputedStyle(asciiOutputElement).fontSize);
        const metrics = measureCharMetrics(fontSizePx, getComputedStyle(document.body).getPropertyValue('--font-code'));
        charWidth = metrics.charWidth;
        charHeight = metrics.charHeight;
      } catch (e) {
        console.warn('Could not measure char metrics, falling back to default.', e);
      }

      // Decode efficiently using createImageBitmap
      let bitmap: ImageBitmap | null = null;
      try {
        const resp = await fetch(imageSrc);
        const blob = await resp.blob();
        bitmap = await createImageBitmap(blob);
      } catch (e) {
        console.warn('createImageBitmap failed, falling back to HTMLImageElement()', e);
      }

      const drawSource = async () => {
        let width: number;
        let height: number;
        if (bitmap) {
          width = bitmap.width;
          height = bitmap.height;
        } else {
          const img = new window.Image();
          img.crossOrigin = 'Anonymous';
          img.src = imageSrc;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Image load error'));
          });
          width = img.width;
          height = img.height;
        }

        const imageAspect = width / height;
        const cols = detail;
        let rows = 0;
        if (isBraille) {
          const brailleCellAspect = 2 / 4;
          rows = Math.round(cols * (1 / imageAspect) * (charHeight / (charWidth / brailleCellAspect)) / 2);
        } else {
          const charAspect = charWidth / charHeight;
          rows = Math.round((cols / imageAspect) * charAspect);
        }
        rows = Math.max(1, rows);

        const canvasCols = isBraille ? cols * 2 : cols;
        const canvasRows = isBraille ? rows * 4 : rows;
        canvas.width = canvasCols;
        canvas.height = canvasRows;

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';

        if (bitmap) {
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        } else {
          // Fallback draw via <img> element if bitmap decode failed
          const img2 = new window.Image();
          img2.crossOrigin = 'Anonymous';
          img2.src = imageSrc;
          await new Promise<void>((resolve, reject) => {
            img2.onload = () => resolve();
            img2.onerror = () => reject(new Error('Image load error'));
          });
          context.drawImage(img2, 0, 0, canvas.width, canvas.height);
        }
      };

      await drawSource();

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const options: any = {
        invertColors,
        charSetName,
        charSet: characterSets[charSetName],
        gamma,
        dithering,
        compactMode,
        preprocess,
        preprocessStrength,
      };
      
      const postToAscii = (extraOptions?: any) => {
        const payload = extraOptions ? { imageData, options: { ...options, ...extraOptions } } : { imageData, options };
        workerRef.current!.postMessage(payload);
      };

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        // Segmentation removed: always run ASCII conversion with current options
        postToAscii();
      }, 200);
    };

    run().catch((e) => {
      console.error(e);
      toast({
        variant: 'destructive',
        title: 'Image Error',
        description: 'Could not load or process the image.',
      });
    });

  }, [imageSrc, detail, invertColors, toast, charSetName, gamma, dithering, compactMode, preprocess, preprocessStrength, generationCount]);

  /** Handle local file uploads using object URLs to reduce memory. */
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Revoke previous blob URL if present
      setImageSrc((prev) => {
        if (prev && prev.startsWith('blob:')) {
          try { URL.revokeObjectURL(prev); } catch {}
        }
        return prev;
      });
      const url = URL.createObjectURL(file);
      setImageSrc(url);
      setIsAiGenerated(false);
      setSourceInfo({ type: 'upload', value: file.name });
    }
  };
  
  /** Submit prompt to the Server Action and trigger AI image generation. */
  const handleFormSubmit = (formData: FormData) => {
    const prompt = formData.get('prompt') as string;
    formData.append('compactMode', compactMode.toString());
    setAsciiArt('');
    setSourceInfo({ type: 'ai', value: prompt });
    setGenerationCount(c => c + 1); // Increment counter on new generation
    formAction(formData);
  };
  
  /** Focus the hidden file input for uploads. */
  const handleUploadClick = () => {
    fileInputRef.current?.click();
  }

  /** Copy raw ASCII output to the clipboard. */
  const copyToClipboard = () => {
    if (asciiArt) {
      navigator.clipboard.writeText(asciiArt);
      toast({
        title: 'Copied to Clipboard',
        description: `The ASCII art has been copied.`,
      });
    }
  };
  
  /** Copy ASCII output wrapped in a Markdown codeblock. */
  const copyToClipboardMarkdown = () => {
    if (asciiArt) {
      const textToCopy = `\`\`\`\n${asciiArt}\`\`\``;
      navigator.clipboard.writeText(textToCopy);
      toast({
        title: 'Copied as Codeblock',
        description: 'The ASCII art has been copied with a Markdown codeblock.',
      });
    }
  };

  /** Clear current image and output; reset UI state. */
  const resetImage = () => {
    setImageSrc(null);
    setAsciiArt('');
    setSourceInfo(null);
    if(fileInputRef.current) fileInputRef.current.value = "";
    // Revoke blob URL to free memory if present
    if (imageSrc && imageSrc.startsWith('blob:')) {
      try { URL.revokeObjectURL(imageSrc); } catch {}
    }
  }

  const activeTab = sourceInfo?.type === 'ai' ? 'generate' : 'upload';


  return (
    <div className="w-full max-w-7xl space-y-8">
      <header className="text-center">
        <h1 className="font-headline text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl text-foreground flex items-center justify-center gap-4">
          <Code className="h-10 w-10" />
          AsciiWorld
        </h1>
        <p className="mt-4 max-w-2xl mx-auto text-muted-foreground md:text-xl">
          Convert your images to ASCII art or generate them from a text prompt.
        </p>
      </header>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>1. Provide an Image</CardTitle>
            <CardDescription>Upload an image or generate one with AI.</CardDescription>
          </div>
           <div className="flex items-center space-x-2 pt-1">
              <Switch
                id="compact-mode-main"
                checked={compactMode}
                onCheckedChange={setCompactMode}
              />
              <Label htmlFor="compact-mode-main" className="text-sm">
                Compact Mode
              </Label>
            </div>
        </CardHeader>
        <CardContent>
          {(!imageSrc || (sourceInfo?.type === 'upload' && imageSrc)) ? (
             <>
             {imageSrc && sourceInfo?.type === 'upload' ? (
                 <div className="flex items-center justify-between rounded-lg border border-border p-4">
                    <div className="flex items-center gap-3">
                       <FileText className="h-6 w-6 text-muted-foreground" />
                       <div>
                           <p className="text-sm font-medium text-foreground truncate">
                               {sourceInfo?.value}
                           </p>
                           <p className="text-xs text-muted-foreground">
                               Uploaded File
                           </p>
                       </div>
                    </div>
                    <Button variant="outline" onClick={resetImage}>Change Image</Button>
                </div>
             ) : (
                <Tabs defaultValue="upload" className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="upload">
                      <ImageIcon className="mr-2 h-4 w-4" /> Upload
                    </TabsTrigger>
                    <TabsTrigger value="generate">
                      <Wand2 className="mr-2 h-4 w-4" /> Generate
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="upload" className="mt-4">
                    <div className="flex flex-col items-center justify-center space-y-4 rounded-lg border-2 border-dashed border-border p-8 text-center h-48">
                      <ImageIcon className="h-12 w-12 text-muted-foreground" />
                      <p className="text-muted-foreground">Select a file from your device</p>
                      <Button onClick={handleUploadClick} variant="outline">Choose File</Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleFileChange}
                        className="hidden"
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="generate" className="mt-4">
                    <form action={handleFormSubmit} className="space-y-4">
                      <Input
                        name="prompt"
                        placeholder="e.g., a photorealistic cat wearing a wizard hat"
                        required
                        className="bg-background"
                      />
                      <GenerateButton />
                    </form>
                  </TabsContent>
                </Tabs>
             )}
             </>
          ) : (
            <Tabs defaultValue={activeTab} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="upload">
                  <ImageIcon className="mr-2 h-4 w-4" /> Upload
                </TabsTrigger>
                <TabsTrigger value="generate">
                  <Wand2 className="mr-2 h-4 w-4" /> Generate
                </TabsTrigger>
              </TabsList>
              <TabsContent value="upload" className="mt-4">
                 <div className="flex flex-col items-center justify-center space-y-4 rounded-lg border-2 border-dashed border-border p-8 text-center h-48">
                      <p className="text-muted-foreground">Switch to the "Upload" tab to choose a new file.</p>
                      <Button onClick={resetImage} variant="outline">Or Start Over</Button>
                  </div>
              </TabsContent>
              <TabsContent value="generate" className="mt-4">
                <form action={handleFormSubmit} className="space-y-4">
                  <Input
                    name="prompt"
                    placeholder="e.g., a photorealistic cat wearing a wizard hat"
                    required
                    className="bg-background"
                    defaultValue={sourceInfo?.type === 'ai' ? sourceInfo.value : ''}
                  />
                  <GenerateButton />
                </form>
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>
      
      {imageSrc && (
        <Tabs defaultValue="result" className="w-full">
            <div className="flex justify-between items-center mb-4">
                 <div className="flex items-baseline gap-4">
                    <h2 className="text-2xl font-bold font-headline">2. Result &amp; Preview</h2>
                    <TabsList>
                        <TabsTrigger value="result">ASCII Result</TabsTrigger>
                        <TabsTrigger value="preview">Source Image</TabsTrigger>
                    </TabsList>
                 </div>
                 {asciiArt && (
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={copyToClipboard}>
                            <Copy className="mr-2 h-4 w-4" />
                            Copy
                        </Button>
                         <Button variant="outline" size="sm" onClick={copyToClipboardMarkdown}>
                            <FileCode className="mr-2 h-4 w-4" />
                            Copy Codeblock
                        </Button>
                      </div>
                  )}
            </div>

          <div className="grid grid-cols-1 md:grid-cols-5 md:gap-8 items-start">
            <div className="md:col-span-2 md:sticky md:top-8 h-fit space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>3. Adjust & Refine</CardTitle>
                  <CardDescription>Control the fineness, character set, and colors of the ASCII art.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 pt-2">
                    <div className="flex items-center gap-2">
                        <Label htmlFor="detail-slider" className="w-20">Columns</Label>
                        <Slider
                          id="detail-slider"
                          min={30}
                          max={300}
                          step={10}
                          value={[detail]}
                          onValueChange={(value) => setDetail(value[0])}
                          disabled={compactMode}
                        />
                        <span className="font-mono text-sm text-muted-foreground w-12 text-right">{detail}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="gamma-slider" className="w-20">Gamma</Label>
                      <Slider
                        id="gamma-slider"
                        min={0.1}
                        max={2.5}
                        step={0.1}
                        value={[gamma]}
                        onValueChange={(value) => setGamma(value[0])}
                      />
                      <span className="font-mono text-sm text-muted-foreground w-12 text-right">{gamma.toFixed(1)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="char-set-select" className="w-20">Character Set</Label>
                      <Select
                        value={charSetName}
                        onValueChange={(value) => setCharSetName(value as keyof typeof characterSets)}
                        disabled={compactMode}
                      >
                        <SelectTrigger id="char-set-select" className="flex-1">
                          <SelectValue placeholder="Select a character set" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="standard">Standard</SelectItem>
                          <SelectItem value="detailed">Detailed</SelectItem>
                          <SelectItem value="simple">Simple</SelectItem>
                          <SelectItem value="binary">Binary</SelectItem>
                          <SelectItem value="braille">Braille</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Preprocess Image controls */}
                  <div className="grid grid-cols-2 gap-x-8 gap-y-3 pt-3 border-t border-border">
                    <div className="flex items-center justify-between col-span-2">
                      <Label htmlFor="preprocess" className="font-medium">Preprocess Image</Label>
                      <Switch
                        id="preprocess"
                        checked={preprocess}
                        onCheckedChange={setPreprocess}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground -mt-2 col-span-2 px-1">Simplifies tones and reduces noise before ASCII mapping.</p>
                    <div className="flex items-center gap-2 col-span-2">
                      <Label htmlFor="preprocess-strength" className="w-32">Re-add Detail</Label>
                      <Slider
                        id="preprocess-strength"
                        min={0}
                        max={10}
                        step={1}
                        value={[preprocessStrength]}
                        onValueChange={(value) => setPreprocessStrength(value[0])}
                        disabled={!preprocess}
                      />
                      <span className="font-mono text-sm text-muted-foreground w-10 text-right">{preprocessStrength}</span>
                    </div>
                  </div>

                    <div className="grid grid-cols-2 gap-x-8 gap-y-3 pt-3 border-t border-border">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="invert-colors" className="font-medium">Invert Colors</Label>
                        <Switch
                          id="invert-colors"
                          checked={invertColors}
                          onCheckedChange={setInvertColors}
                        />
                      </div>
                       <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center justify-between">
                              <Label htmlFor="dithering" className={compactMode ? "text-muted-foreground cursor-not-allowed" : "font-medium"}>
                                Dithering
                              </Label>
                              <Switch
                                id="dithering"
                                checked={dithering}
                                onCheckedChange={setDithering}
                                disabled={compactMode}
                              />
                            </div>
                          </TooltipTrigger>
                          {compactMode && (
                            <TooltipContent>
                              <p>Disabled during compact mode</p>
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TooltipProvider>
                       <p className="text-xs text-muted-foreground -mt-2 col-span-2 px-1">"Invert" swaps light/dark characters. "Dithering" simulates more shades of gray.</p>
                    </div>
                </CardContent>
              </Card>
            </div>
            
            <div className="md:col-span-3 space-y-4">
                <TabsContent value="result">
                    <Card className="bg-card w-full">
                        <CardContent className="p-2 aspect-square flex items-center justify-center">
                            <div ref={asciiContainerRef} className="w-full h-full flex items-center justify-center">
                            {asciiArt ? (
                                <pre className="font-code text-foreground text-[5px] leading-tight animate-in fade-in duration-500 overflow-auto">
                                {asciiArt}
                                </pre>
                            ) : (
                                <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    { imageSrc ? <Loader2 size={64} className="animate-spin" /> : <Code size={64} />}
                                    <p className="mt-2">{ imageSrc ? 'Converting...' : 'Result will appear here' }</p>

                                </div>
                            )}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
                <TabsContent value="preview">
                    <Card className="bg-card w-full">
                        <CardContent className="p-2 aspect-square flex items-center justify-center overflow-hidden">
                            {imageSrc ? (
                              imageSrc.startsWith('blob:') ? (
                                <img
                                  src={imageSrc}
                                  alt="Source for ASCII conversion"
                                  width={500}
                                  height={500}
                                  className="object-contain h-full w-full"
                                />
                              ) : (
                                <Image
                                  src={imageSrc}
                                  alt="Source for ASCII conversion"
                                  width={500}
                                  height={500}
                                  className="object-contain h-full w-full"
                                />
                              )
                            ) : null}
                        </CardContent>
                    </Card>
                </TabsContent>
            </div>
          </div>
        </Tabs>
      )}
      
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
