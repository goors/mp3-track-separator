"use client";

import React, { useRef, useState, useEffect } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Button } from "@/components/ui/button";
import { Play, Square, Download, Loader2 } from "lucide-react";

interface SourcePlayerProps {
    videoId: string;
    trackTitle: string;
    fileName?: string;
}

const SourcePlayer: React.FC<SourcePlayerProps> = ({ videoId, trackTitle, fileName }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const ws = useRef<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    // Create a unique ID for this specific player instance (Video + File)
    // This ensures Vocals, Drums, and Bass are treated as different players.
    const instanceId = `${videoId}-${fileName || 'source'}`;

    // 1. SYNC LOGIC: Listen for the global play event
    useEffect(() => {
        const handleOtherPlay = (e: any) => {
            // If the event didn't come from THIS specific instance, pause
            if (e.detail.id !== instanceId && isPlaying) {
                ws.current?.pause();
            }
        };

        window.addEventListener('player-play', handleOtherPlay);
        return () => window.removeEventListener('player-play', handleOtherPlay);
    }, [instanceId, isPlaying]);

    // 2. DATA LOADING (Your working logic)
    useEffect(() => {
        if (!videoId) return;
        const loadFile = async () => {
            try {
                const base = await appDataDir();
                const targetFile = fileName || "source.mp3";
                const path = await join(base, videoId, targetFile);

                // Read bytes from Rust
                const bytes = await invoke<number[]>("read_audio_file", { path });

                const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }));
                setBlobUrl(url);
            } catch (err) {
                console.error("Path/Read Error:", err);
            }
        };
        void loadFile();
        return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
    }, [videoId, fileName]);

    // 3. WAVESURFER INIT (Your working logic)
    useEffect(() => {
        if (!containerRef.current || !blobUrl) {
            setIsReady(false); // This is safe here because it's a guard clause
            return;
        }

        // DO NOT call setIsReady(false) here synchronously.

        const timer = setTimeout(() => {
            // Create the instance
            const wavesurfer = WaveSurfer.create({
                container: containerRef.current!,
                waveColor: '#cbd5e1',
                progressColor: '#1a73e8',
                height: 30,
                barWidth: 2,
                barGap: 1,
                normalize: true,
                url: blobUrl,
                backend: 'WebAudio',
                hideScrollbar: true,
                interact: true,
                fillParent: true,

            });

            // Event Listeners
            wavesurfer.on('ready', () => {
                setIsReady(true); // This happens asynchronously, so it's safe.
            });

            wavesurfer.on('play', () => {
                setIsPlaying(true);
                window.dispatchEvent(new CustomEvent('player-play', {
                    detail: { id: instanceId }
                }));
            });

            wavesurfer.on('pause', () => setIsPlaying(false));
            wavesurfer.on('finish', () => setIsPlaying(false));

            // Use a functional play to ensure context is resumed
            wavesurfer.on('interaction', () => wavesurfer.play());

            ws.current = wavesurfer;
        }, 50);

        return () => {
            setIsReady(false); // Reset state when unmounting or blob changes
            ws.current?.destroy();
            clearTimeout(timer);
        };
    }, [blobUrl, instanceId]);

    const downloadSource = (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            invoke("download_source_file", { videoId, suggestedName: trackTitle, fileName });
        } catch (err) {
            console.error("Save failed:", err);
        }
    };

    return (
        <div className="flex items-center gap-3 h-10 w-full group">
            <Button
                variant="ghost"
                size="icon"
                disabled={!isReady}
                className={`h-7 w-7 shrink-0 rounded-md transition-all active:scale-95 ${
                    isPlaying
                        ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-100'
                        : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border border-slate-200/60'
                }`}
                onClick={(e) => {
                    e.stopPropagation();
                    ws.current?.playPause();
                }}
            >
                {!isReady ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                ) : isPlaying ? (
                    <Square className="w-2.5 h-2.5 fill-current" />
                ) : (
                    <Play className="w-2.5 h-2.5 fill-current ml-0.5" />
                )}
            </Button>

            <div className="flex-grow relative h-[30px] min-w-[120px]">
                <div
                    ref={containerRef}
                    className={`w-full h-full cursor-pointer transition-opacity duration-500 ${isReady ? 'opacity-100' : 'opacity-0'}`}
                />
                {!isReady && (
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full h-[1px] bg-slate-200 animate-pulse" />
                    </div>
                )}
            </div>

            <Button
                variant="ghost"
                size="icon"
                disabled={!isReady}
                className="h-8 w-8 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={downloadSource}
            >
                <Download className="w-3.5 h-3.5" />
            </Button>
        </div>
    );
};

export default SourcePlayer;