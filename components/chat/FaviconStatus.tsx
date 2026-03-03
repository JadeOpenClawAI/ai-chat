'use client';

import { useEffect, useRef } from 'react';

const ICON_SIZE = 32;
const IDLE_FRAME_MS = 40;
const TYPING_FRAME_MS = 105;
const IDLE_FRAME_COUNT = 48;
const TYPING_FRAME_COUNT = 16;
const ICON_LINK_RELS = ['icon', 'shortcut icon'] as const;

type FrameCache = {
  idle: string[];
  typing: string[];
};

function ensureFaviconLink(rel: (typeof ICON_LINK_RELS)[number]): HTMLLinkElement {
  const existing = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (existing) {
    return existing;
  }
  const link = document.createElement('link');
  link.rel = rel;
  document.head.appendChild(link);
  return link;
}

function setFavicon(href: string, type: string) {
  for (const rel of ICON_LINK_RELS) {
    const link = ensureFaviconLink(rel);
    link.type = type;
    link.href = href;
  }
}

function drawIdlePulse(ctx: CanvasRenderingContext2D, phase: number, reduceMotion: boolean) {
  const cx = ICON_SIZE / 2;
  const cy = ICON_SIZE / 2;
  const pulse = reduceMotion ? 0.5 : (1 - Math.cos(phase * Math.PI * 2)) / 2;

  const coreRadius = 6.8 + pulse * 0.35;
  const ringRadius = 12.4 + pulse * 0.9;
  const glowRadius = 14.8;
  const ringAlpha = 0.12 + pulse * 0.16;
  const glowAlpha = 0.05 + pulse * 0.08;

  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);

  ctx.beginPath();
  ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(124, 58, 237, ${glowAlpha.toFixed(3)})`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(124, 58, 237, ${ringAlpha.toFixed(3)})`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#7C3AED';
  ctx.fill();
}

function typingDotIntensity(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const cosine = Math.cos(p * Math.PI * 2);
  return 0.35 + Math.max(0, cosine) * 0.65;
}

function drawTypingDots(ctx: CanvasRenderingContext2D, phase: number, reduceMotion: boolean) {
  const cx = ICON_SIZE / 2;
  const cy = ICON_SIZE / 2;
  const baseY = cy;

  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);

  for (let i = 0; i < 3; i += 1) {
    const localPhase = phase - i * 0.18;
    const intensity = reduceMotion ? (i === 1 ? 1 : 0.7) : typingDotIntensity(localPhase);
    const alpha = 0.45 + intensity * 0.55;
    const y = reduceMotion ? baseY : baseY + Math.sin((phase + i * 0.08) * Math.PI * 2) * 0.55;
    const x = cx - 9 + i * 9;
    const radius = 3.6 + intensity * 0.9;

    ctx.beginPath();
    ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(134, 239, 172, ${(alpha * 0.25).toFixed(3)})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(134, 239, 172, ${alpha.toFixed(3)})`;
    ctx.fill();
  }
}

function renderFrames(
  frameCount: number,
  draw: (ctx: CanvasRenderingContext2D, phase: number, reduceMotion: boolean) => void,
  reduceMotion: boolean,
): string[] {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    return [];
  }

  const frames: string[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    draw(ctx, i / frameCount, reduceMotion);
    frames.push(canvas.toDataURL('image/png'));
  }
  return frames;
}

function buildFrameCache(reduceMotion: boolean): FrameCache {
  return {
    idle: renderFrames(IDLE_FRAME_COUNT, drawIdlePulse, reduceMotion),
    typing: renderFrames(TYPING_FRAME_COUNT, drawTypingDots, reduceMotion),
  };
}

export function FaviconStatus({ awaitingResponse }: { awaitingResponse: boolean }) {
  const baseHrefRef = useRef<string | null>(null);
  const baseTypeRef = useRef<string>('image/x-icon');
  const normalFramesRef = useRef<FrameCache | null>(null);
  const reducedFramesRef = useRef<FrameCache | null>(null);

  useEffect(() => {
    const iconLink = document.head.querySelector<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]');
    if (!baseHrefRef.current) {
      baseHrefRef.current = iconLink?.href ?? '/favicon.ico';
      baseTypeRef.current = iconLink?.type || 'image/x-icon';
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cacheRef = reduceMotion ? reducedFramesRef : normalFramesRef;
    if (!cacheRef.current) {
      cacheRef.current = buildFrameCache(reduceMotion);
    }

    const frames = awaitingResponse ? cacheRef.current.typing : cacheRef.current.idle;
    if (frames.length === 0) {
      return undefined;
    }

    const frameMs = awaitingResponse ? TYPING_FRAME_MS : IDLE_FRAME_MS;
    let index = 0;
    setFavicon(frames[index], 'image/png');

    const timer = window.setInterval(() => {
      index = (index + 1) % frames.length;
      setFavicon(frames[index], 'image/png');
    }, frameMs);

    return () => window.clearInterval(timer);
  }, [awaitingResponse]);

  useEffect(() => () => {
    if (baseHrefRef.current) {
      setFavicon(baseHrefRef.current, baseTypeRef.current);
    }
  }, []);

  return null;
}
