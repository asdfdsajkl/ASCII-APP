'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

const AsciiWorld = dynamic(() => import('@/components/ascii-world').then(mod => mod.AsciiWorld), {
  ssr: false,
  loading: () => (
    <div className="flex h-[80vh] w-full flex-col items-center justify-center text-muted-foreground">
      <Loader2 className="mb-4 h-16 w-16 animate-spin" />
      <p className="text-xl">Loading AsciiWorld Engine...</p>
    </div>
  ),
});


export default function Home() {
  return (
    <main className="flex w-full flex-col items-center justify-start p-4 md:p-8">
      <AsciiWorld />
    </main>
  );
}
