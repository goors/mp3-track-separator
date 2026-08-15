"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Music, Download } from "lucide-react";
import SourcePlayer from "@/components/source-player";

const STEM_TYPES = [
    { id: 'vocals', label: 'Vocals' },
    { id: 'drums', label: 'Drums' },
    { id: 'bass', label: 'Bass' },
    { id: 'guitar', label: 'Guitar' },
    { id: 'piano', label: 'Piano' },
    { id: 'other', label: 'Other' },
];

function StemsContent() {
    const searchParams = useSearchParams();
    const [videoId, setVideoId] = useState<string | null>(searchParams.get('videoId'));
    const [title, setTitle] = useState<string | null>(searchParams.get('title'));
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const appWindow = getCurrentWebviewWindow();
        let unlistenFn: (() => void) | null = null;

        const setupListeners = async () => {
            const unlisten = await listen<{video_id: string, title: string}>('shred-data', (event) => {
                setVideoId(event.payload.video_id);
                setTitle(event.payload.title);
                setIsLoading(false);
            });
            unlistenFn = unlisten;
            await appWindow.emit('view-ready');
            if (searchParams.get('videoId')) setIsLoading(false);
        };

        setupListeners();
        return () => { if (unlistenFn) unlistenFn(); };
    }, [searchParams]);

    if (isLoading && !videoId) {
        return (
            <div className="h-screen flex items-center justify-center bg-white">
                <div className="w-5 h-5 border-2 border-neutral-200 border-t-neutral-800 rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="h-screen flex flex-col bg-white select-none font-sans antialiased">
            {/* HEADER */}
            <header className="h-12 border-b border-t border-neutral-200 flex items-center px-4 shrink-0">
                <div className="flex items-center gap-3 truncate">
                    <div className="w-8 h-8 bg-neutral-100 rounded flex items-center justify-center shrink-0 border border-neutral-200">
                        <Music size={14} className="text-neutral-500" />
                    </div>
                    <h1 className="text-[14px] font-medium text-neutral-900 truncate">
                        {title || "Untitled Shred"}
                    </h1>
                </div>
            </header>

            {/* STEM ROWS */}
            <main className="flex-grow overflow-y-auto">
                <table className="w-full border-collapse">
                    <tbody>
                    {STEM_TYPES.map((stem) => (
                        <tr key={stem.id} className="border-b border-neutral-100 bg-white">
                            {/* 1. Label */}
                            <td className="w-32 pl-6 py-3">
                                    <span className="text-[11px] text-neutral-500 tracking-wider">
                                        {stem.label}
                                    </span>
                            </td>

                            {/* 2. Player (Takes rest of space) */}
                            <td className="px-4 py-3">
                                <SourcePlayer
                                    videoId={videoId!}
                                    trackTitle={`${title} - ${stem.label}`}
                                    fileName={`${stem.id}.mp3`}
                                />
                            </td>


                        </tr>
                    ))}
                    </tbody>
                </table>
            </main>

            {/* STATUS FOOTER */}
            <footer className="h-7 border-t border-neutral-200 bg-[#f8f9fa] flex items-center px-4">
                <span className="text-[9px] text-neutral-400 font-medium uppercase tracking-tight tabular-nums">
                    UUID: {videoId}
                </span>
            </footer>
        </div>
    );
}

export default function StemsPage() {
    return (
        <Suspense fallback={null}>
            <StemsContent />
        </Suspense>
    );
}