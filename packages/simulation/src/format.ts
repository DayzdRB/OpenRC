import type { AircraftState } from "./types";

export function formatHeading(heading: number): string {
  const rounded = Math.round(heading) % 360 || 360;
  return `${String(rounded).padStart(3, "0")}°`;
}

export function formatAltitude(altitudeFt: number): string {
  const rounded = Math.round(altitudeFt / 100) * 100;
  if (rounded >= 18000) return `FL${String(Math.round(rounded / 100)).padStart(3, "0")}`;
  return `${rounded.toLocaleString("en-US")} ft`;
}

export function formatSpeed(speedKts: number): string {
  return `${Math.round(speedKts)} kts`;
}

export function compactStripLines(aircraft: AircraftState): [string, string, string, string] {
  return [
    aircraft.callsign,
    aircraft.aircraftType,
    `${formatHeading(aircraft.headingDeg)} ${formatAltitude(aircraft.altitudeFt)} ${formatSpeed(aircraft.speedKts)}`,
    aircraft.flightPlan.controllerRelevantDestination
  ];
}
