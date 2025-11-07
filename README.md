# AsciiWorld

Generate crisp ASCII art from images in your browser. Optionally, you can use a text prompt to generate an image (via Google AI) and then convert it.

## Features
- Upload an image from your device.
- Optional: generate an image from a text prompt.
- Adjust ASCII columns and character set (`standard`, `detailed`, `simple`, `binary`).
- Compact Mode for Braille-style output.
- Toggle color inversion and dithering.
- Copy raw ASCII or Markdown codeblock.

## Requirements
- Node.js 18+

## Setup
```bash
npm install
```

If you want AI image generation:
- Copy `.env.example` to `.env` and set `GOOGLE_API_KEY`.

## Run
```bash
npm run dev
```
Open the URL printed in the terminal (e.g., `http://localhost:9002`).

## Usage
- Upload a local image, or enter a prompt and click Generate.
- Use “Adjust & Refine” to change columns, character set, inversion, and dithering.
- Copy the ASCII result if you want to share or save it.

## Scripts
- `npm run dev`: start the dev server.
- `npm run build`: build for production.
- `npm run start`: run the production build.
- Optional (advanced): `npm run genkit:dev`, `npm run genkit:watch`.
