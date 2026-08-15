"use client";

import { open } from "@tauri-apps/plugin-dialog";
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    Trash2, Search, Activity, Loader2, Upload, Music, Inbox, Scissors, MessageSquare, Download
} from "lucide-react";
import { appDataDir, join } from "@tauri-apps/api/path";
import SourcePlayer from "@/components/source-player";
import { Footer } from "@/components/footer";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

// --- HELPERS (Outside to prevent re-declaration) ---

const formatViews = (n: number) => {
    if (!n || n === 0) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
};

// --- TYPES & INTERFACES ---

interface ProgressPayload {
    video_id: string;
    progress: number;
    status: string;
    meta?: {
        title?: string;
        uploader?: string;
    };
}

interface HistoryItem {
    video_id: string;
    meta: {
        title: string;
        uploader: string;
        thumbnail: string;
        view_count: number;
        like_count?: number;
        comment_count?: number;
        filesize_approx: number;
        original_extension?: string;
        is_local?: boolean;
    };
    stems_sizes?: Record<string, number>;
    isSourceReady?: boolean;
}

const ProcessingRow = React.memo(({ item }: { item: ProgressPayload }) => (
    <tr className="border-b border-[#f2f2f2] h-[68px] bg-[#fcfcfc]">
        <td className="w-[48px] pl-5">
            <div className="w-8 h-8 rounded-md flex items-center justify-center bg-neutral-50 border border-neutral-200">
                <Loader2 className="w-4 h-4 text-neutral-400 animate-spin" />
            </div>
        </td>
        <td className="px-4 w-[280px] shrink-0">
            <div className="flex flex-col truncate">
                <span className="text-[13px] text-neutral-900 truncate">
                    {item.meta?.uploader || "Source"}
                </span>
                <span className="text-[11px] text-neutral-500 truncate font-medium">
                    {item.meta?.title || "Initializing..."}
                </span>
            </div>
        </td>
        <td className="px-4 flex-grow">
            <div className="flex items-center gap-4">
                <div className="flex-grow max-w-[400px] h-1 bg-neutral-200 rounded-full overflow-hidden">
                    <div className="h-full bg-neutral-500 transition-all duration-500" style={{ width: `${item.progress}%` }} />
                </div>
                <span className="text-[10px] text-neutral-400 font-medium uppercase tracking-tight whitespace-nowrap">
                    {item.status} ({Math.round(item.progress)}%)
                </span>
            </div>
        </td>
        <td className="px-4 text-right w-[150px]" />
    </tr>
));
ProcessingRow.displayName = "ProcessingRow";

const HistoryRow = React.memo(({ item, isLocal, onDelete }: { item: HistoryItem, isLocal: boolean, onDelete: (id: string) => void }) => {

    return (
        <>
            {/* 1. MASTER ROW - High Contrast Punch */}
            <TableRow className="group border-b border-neutral-200 h-16 bg-white hover:bg-neutral-50 transition-colors cursor-pointer">
                <TableCell className="pl-6 w-12">
                    <div className="w-10 h-10 rounded-none bg-neutral-900 flex items-center justify-center overflow-hidden">
                        {isLocal ? (
                            <Music size={16} className="text-white" />
                        ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.meta?.thumbnail} className="w-full h-full object-cover" alt="" />
                        )}
                    </div>
                </TableCell>

                <TableCell className="px-4 w-[240px]">
                    <div className="flex flex-col">
                        {/* Darker text for more 'ink' on the page */}
                        <span className="text-[13px] text-black truncate block font-normal leading-tight">
                            {item.meta?.title || "Untitled"}
                        </span>
                        <span className="text-[9px] text-blue-600 uppercase tracking-[0.2em] font-normal mt-0.5">
                            Original Master
                        </span>
                    </div>
                </TableCell>

                <TableCell className="px-4">
                    <div className="flex-grow">
                        <SourcePlayer
                            videoId={item.video_id}
                            trackTitle={item.meta?.title}
                            fileName={isLocal ? `source.${item.meta?.original_extension}` : "source.mp3"}
                        />
                    </div>
                </TableCell>

                <TableCell className="pr-6 text-right w-52">
                    <div className="flex items-center justify-end gap-4">
                        {/* Higher opacity for meta stats */}
                        <div className="flex items-center gap-2 text-[11px] text-neutral-600 font-normal tabular-nums group-hover:hidden whitespace-nowrap">
                            <span>{formatViews(item.meta?.view_count || 0)} views</span>
                            <span className="text-neutral-300">|</span>
                            <div className="flex items-center gap-1">
                                <MessageSquare size={12} className="text-neutral-400" />
                                <span>{item.meta?.comment_count || 0}</span>
                            </div>
                            <span className="text-neutral-300">|</span>
                            <span>{((item.meta?.filesize_approx || 0) / (1024 * 1024)).toFixed(1)} MB</span>
                        </div>

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => { e.stopPropagation(); onDelete(item.video_id); }}
                            className="hidden group-hover:flex h-8 w-8 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-none"
                        >
                            <Trash2 size={16}/>
                        </Button>
                    </div>
                </TableCell>
            </TableRow>

            {/* 2. STEMS SECTION - Darker Cool Gray (Slate) for Depth */}
            <TableRow className="bg-[#f1f5f9] border-b border-neutral-300">
                <TableCell colSpan={4} className="p-0">
                    <div className="flex flex-col border-l-4 border-blue-500/20">
                        {Object.entries(item.stems_sizes || {}).map(([file, size]) => {
                            if (Number(size) <= 0 || file.startsWith('source')) return null;
                            const label = file.split('.')[0];

                            return (
                                <div
                                    key={`${item.video_id}-${file}`}
                                    className="flex items-center gap-6 py-3 px-12 hover:bg-white/40 transition-colors group/stem"
                                >
                                    <div className="w-24 shrink-0">
                                        <span className="text-[10px] text-neutral-700 uppercase tracking-[0.25em] font-normal">
                                            {label}
                                        </span>
                                    </div>

                                    <div className="flex-grow">
                                        <SourcePlayer
                                            videoId={item.video_id}
                                            trackTitle={`${item.meta.title} - ${label}`}
                                            fileName={file}
                                        />
                                    </div>

                                    <div className="flex items-center gap-4 shrink-0">
                                        <span className="text-[10px] text-neutral-500 tabular-nums font-normal">
                                            {(Number(size) / (1024 * 1024)).toFixed(1)} MB
                                        </span>
                                    </div>
                                </div>
                            );
                        })}

                        {/* Flat Action Button */}
                        <div className="flex items-center justify-end px-12 py-3 border-t border-neutral-200/60 bg-neutral-200/10">
                            <button
                                onClick={() => invoke("download_all_stems", {
                                    videoId: item.video_id,
                                    suggestedName: item.meta?.title || "stems"
                                })}
                                className="text-[10px] text-neutral-500 hover:text-blue-700 uppercase tracking-widest py-1 flex items-center gap-2 font-normal transition-colors"
                            >
                                <Download size={12} />
                                Download all stems
                            </button>
                        </div>
                    </div>
                </TableCell>
            </TableRow>
        </>
    );
});
HistoryRow.displayName = "HistoryRow";

// --- MAIN COMPONENT ---

export default function App() {
    const [url, setUrl] = useState("");
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [processing, setProcessing] = useState<Record<string, ProgressPayload>>({});
    const [isPending, setIsPending] = useState(false);


    // loadHistory is now stable and doesn't wipe state unnecessarily
    const loadHistory = useCallback(async () => {
        try {
            const data = await invoke<HistoryItem[]>("get_shred_history");
            const base = await appDataDir();

            const hydrated = await Promise.all(data.map(async (item) => {
                const path = await join(base, item.video_id, "source.mp3");
                const exists = await invoke<boolean>("check_file_exists", { path });
                return { ...item, isSourceReady: exists };
            }));

            // Only update if data actually changed to prevent flicker
            setHistory(hydrated);
        } catch (e) {
            console.error("SHRED_HISTORY_ERR:", e);
        }
    }, []);



    const syncActiveJobs = useCallback(async () => {
        try {
            const activeJobs = await invoke<Record<string, never>>("get_active_shreds");
            setProcessing(activeJobs || {});
        } catch (e) {
            console.error("Failed to sync active jobs:", e);
        }
    }, []);


    useEffect(() => {
        void loadHistory();
        void syncActiveJobs();
    }, [loadHistory, syncActiveJobs]);

    useEffect(() => {
        const unlisten = listen<ProgressPayload>("processing-shred", (event) => {
            const payload = event.payload;

            // If it's done (100%), remove from processing and refresh history
            if (payload.progress >= 100) {
                setProcessing(prev => {
                    const next = { ...prev };
                    delete next[payload.video_id];
                    return next;
                });
                void loadHistory();
                return;
            }

            setProcessing((prev) => ({ ...prev, [payload.video_id]: payload }));
        });
        return () => { unlisten.then((f) => f()); };
    }, [loadHistory]);

    const handleProcess = async () => {
        if (!url || isPending) return;
        const currentUrl = url;
        setUrl("");
        setIsPending(true);
        try {
            const mp3Path = await invoke<string>("download_youtube_to_mp3", { url: currentUrl });
            await invoke<string[]>("run_ai_separation", { inputPath: mp3Path });
            await loadHistory();
        } catch (e) {
            console.error("SHRED_ERR:", e);
        } finally {
            setIsPending(false);
            void syncActiveJobs();
        }
    };

    const handleFileOpen = async () => {
        const selected = await open({
            multiple: false,
            filters: [{ name: 'Audio', extensions: ['mp3', 'wav'] }]
        });
        if (selected) {
            setIsPending(true);
            try {
                await invoke("process_local_file", { path: selected as string });
                await loadHistory();
            } catch (e) {
                console.error("LOCAL_ERR:", e);
            } finally {
                setIsPending(false);
                void syncActiveJobs();
            }
        }
    };

    const handleDelete = useCallback(async (videoId: string) => {
        try {
            await invoke("delete_shred", { videoId });
            setHistory(prev => prev.filter(i => i.video_id !== videoId));
        } catch (e) {
            console.error("DELETE_ERR:", e);
        }
    }, []);

    const { localFiles, youtubeFiles, hasAnyFiles } = useMemo(() => {
        const processingIds = new Set(Object.keys(processing));
        const locals = history.filter(item => item.meta?.is_local && !processingIds.has(item.video_id));
        const youtube_tracks = history.filter(item => !item.meta?.is_local && !processingIds.has(item.video_id));
        return {
            localFiles: locals,
            youtubeFiles: youtube_tracks,
            hasAnyFiles: locals.length > 0 || youtube_tracks.length > 0 || processingIds.size > 0
        };
    }, [history, processing]);

    return (
        <div className="h-screen w-full bg-[#f6f6f6] flex flex-col overflow-hidden text-neutral-900 font-sans antialiased">
            <header className="h-[72px] border-t flex items-center px-6 gap-4 border-b border-neutral-300 bg-white shrink-0 z-10">
                {/* 1. Logo - Solid Neutral-900 for high 'ink' density */}
                <div className="w-10 h-10 bg-neutral-900 flex items-center justify-center shrink-0">
                    <Activity className="text-white w-5 h-5" />
                </div>

                {/* 2. Control Container */}
                <div className="flex-grow flex items-center gap-3">

                    {/* Local Button - Flat, no shadow, sharp corners */}
                    <button
                        onClick={handleFileOpen}
                        className="h-10 px-4 bg-neutral-100 border border-neutral-300 text-neutral-600 hover:bg-neutral-200 hover:text-black transition-all flex items-center gap-2 text-[12px] font-normal shrink-0"
                    >
                        <Upload size={16} className="opacity-70" />
                        <span>Open Local</span>
                    </button>

                    {/* Search/URL Input Wrapper */}
                    <div className="relative flex-grow flex items-center">
                        <div className="relative w-full">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
                            <input
                                className="w-full h-10 pl-10 pr-32 bg-neutral-50 border border-neutral-300 outline-none text-[13px] text-black focus:bg-white focus:border-blue-500 transition-all"
                                placeholder="Paste YouTube URL..."
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleProcess()}
                            />

                            {/* Action Button - Pure Black/High Contrast */}
                            <button
                                onClick={handleProcess}
                                disabled={!url || isPending}
                                className="absolute right-1 top-1 bottom-1 px-4 bg-neutral-900 text-white text-[10px] font-normal uppercase tracking-widest hover:bg-black disabled:opacity-20 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                            >
                                {isPending ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />}
                                Separate
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            <div className="flex-grow overflow-auto bg-white flex flex-col">
                {!hasAnyFiles ? (
                    <div className="flex-grow flex flex-col items-center justify-center text-neutral-300 gap-4">
                        <Inbox size={48} strokeWidth={1} />
                        <div className="flex flex-col items-center">
                            <p className="text-[13px] font-medium text-neutral-400">No tracks processed</p>
                            <p className="text-[11px]">Paste a YouTube link or open a local file to extract stems.</p>
                        </div>
                    </div>
                ) : (
                    <Table className="w-full border-collapse">
                        <TableHeader className="sticky top-0 bg-white/95 backdrop-blur z-20 border-b border-neutral-100">
                            <TableRow className="h-10 hover:bg-transparent border-none">
                                <TableHead className="w-[64px] pl-6 text-[10px] text-neutral-400 uppercase tracking-widest font-normal">
                                    Type
                                </TableHead>
                                <TableHead className="w-[240px] px-4 text-[10px] text-neutral-400 uppercase tracking-widest font-normal">
                                    Source Detail
                                </TableHead>
                                <TableHead className="px-4 text-[10px] text-neutral-400 uppercase tracking-widest font-normal">
                                    Separation & Playback
                                </TableHead>
                                <TableHead className="w-[160px] pr-6 text-right text-[10px] text-neutral-400 uppercase tracking-widest font-normal">
                                    Size / Meta
                                </TableHead>
                            </TableRow>
                        </TableHeader>

                        <TableBody>
                            {Object.values(processing ?? []).map((p) => (
                                <ProcessingRow key={p.video_id ?? 0} item={p} />
                            ))}

                            {localFiles.length > 0 && (
                                <TableRow className="bg-[#f8f9fa] h-8 border-none hover:bg-[#f8f9fa]">
                                    <TableCell colSpan={4} className="px-6 py-0 text-[9px] text-neutral-400 uppercase tracking-[0.2em] font-normal">
                                        Local Assets
                                    </TableCell>
                                </TableRow>
                            )}
                            {localFiles.map((item) => (
                                <HistoryRow key={item.video_id} item={item} isLocal={true} onDelete={handleDelete} />
                            ))}

                            {youtubeFiles.length > 0 && (
                                <TableRow className="bg-[#f8f9fa] h-8 border-none hover:bg-[#f8f9fa]">
                                    <TableCell colSpan={4} className="px-6 py-0 text-[9px] text-neutral-400 uppercase tracking-[0.2em] font-normal">
                                        Cloud Archives
                                    </TableCell>
                                </TableRow>
                            )}
                            {youtubeFiles.map((item) => (
                                <HistoryRow key={item.video_id} item={item} isLocal={false} onDelete={handleDelete} />
                            ))}
                        </TableBody>
                    </Table>
                )}
            </div>

            <Footer historyCount={history.length} />
        </div>
    );
}