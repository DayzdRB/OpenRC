import type { Vec2 } from "./types";

export const normalizeHeading = (heading: number) => ((heading % 360) + 360) % 360;

export function shortestTurnDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export function turnToward(from: number, to: number, maxDelta: number): number {
  const delta = shortestTurnDelta(from, to);
  if (Math.abs(delta) <= maxDelta) return normalizeHeading(to);
  return normalizeHeading(from + Math.sign(delta) * maxDelta);
}

export function distanceNm(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function headingTo(a: Vec2, b: Vec2): number {
  const radians = Math.atan2(b.x - a.x, b.y - a.y);
  return normalizeHeading((radians * 180) / Math.PI);
}

export function move(position: Vec2, headingDeg: number, speedKts: number, dtSec: number): Vec2 {
  const distance = (speedKts * dtSec) / 3600;
  const radians = (headingDeg * Math.PI) / 180;
  return {
    x: position.x + Math.sin(radians) * distance,
    y: position.y + Math.cos(radians) * distance,
  };
}

export function projectPosition(position: Vec2, headingDeg: number, speedKts: number, seconds: number): Vec2 {
  return move(position, headingDeg, speedKts, seconds);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
