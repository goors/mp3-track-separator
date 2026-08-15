"use client";

import { Activity, Cpu, HardDrive, Zap, Loader2 } from "lucide-react";
import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SystemStats {
    cpu_model: string;
    cpu_usage: number;
    memory_used: number;
    memory_total: number;
    has_gpu: boolean;
    os_name: string;
}

export function Footer({ historyCount }: { historyCount: number }) {
    const [stats, setStats] = useState<SystemStats | null>(null);

    // Self-contained stats polling
    useEffect(() => {
        const update = async () => {
            try {
                const res = await invoke<SystemStats>("get_system_stats");
                setStats(res);
            } catch (e) {
                console.error("Stats poll failed", e);
            }
        };

        update();
        const interval = setInterval(update, 2000);
        return () => clearInterval(interval);
    }, []);

    const formatSizeFromMB = (mb: number) => {
        if (mb >= 1024) {
            return `${(mb / 1024).toFixed(1)}GB`;
        }
        return `${mb}MB`;
    };

    return (
        <footer className="h-8 bg-[#f0f0f0] border-t border-neutral-300 flex items-center px-4 justify-between text-[11px] text-neutral-500 shrink-0 select-none font-sans antialiased">
            <div className="flex gap-6 items-center">
                {/* 1. Track Count */}
                <div className="flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 opacity-40" />
                    <span className="tabular-nums tracking-tight uppercase">
                        {historyCount} Tracks
                    </span>
                </div>

                {/* 2. CPU Usage & Model */}
                <div className="flex items-center gap-1.5 cursor-default">
                    <Cpu className="w-3.5 h-3.5 opacity-40" />
                    <span className="tabular-nums min-w-[28px]">
                        {stats ? `${stats.cpu_usage.toFixed(0)}%` : "--"}
                    </span>
                    <span className="text-[10px] opacity-30 truncate max-w-[140px]">
                        {stats?.cpu_model.split('@')[0].trim()}
                    </span>
                </div>

                {/* 3. Memory Usage */}
                <div className="flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 opacity-40" />
                    <span className="tabular-nums flex gap-1 tracking-tight">
                        {stats ? (
                            <>
                                <span className="text-neutral-700">{formatSizeFromMB(stats.memory_used)}</span>
                                <span className="opacity-20">/</span>
                                <span>{formatSizeFromMB(stats.memory_total)}</span>
                            </>
                        ) : (
                            "---"
                        )}
                    </span>
                </div>

                {/* 4. GPU Status */}
                {stats?.has_gpu && (
                    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600 text-[9px] font-medium tracking-tighter border border-neutral-300 uppercase">
                        <Zap className="w-2.5 h-2.5 fill-current" />
                        GPU_ACCEL
                    </div>
                )}
            </div>

            {/* 5. System Status */}
            <div className="flex items-center gap-3">
                <span className="text-[9px] opacity-30 uppercase tracking-widest">{stats?.os_name}</span>
                <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${stats ? 'bg-neutral-400' : 'bg-neutral-200 animate-pulse'}`} />
                    <span className="uppercase tracking-[0.1em] text-[9px] font-medium opacity-50">
                        {stats ? "Ready" : "Wait"}
                    </span>
                </div>
            </div>
        </footer>
    );
}