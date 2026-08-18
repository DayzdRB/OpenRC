"use client";

import { useEffect, useRef, useState } from "react";
import type { AircraftState, SimulationState, Vec2, Waypoint } from "@openrc/simulation";
import { formatAltitude } from "@openrc/simulation";

interface RadarScopeProps {
  state: SimulationState;
  selectedAircraftId: string | null;
  selectedWaypointId: string | null;
  onSelectAircraft: (id: string | null) => void;
  onSelectWaypoint: (id: string | null) => void;
  onCreateWaypoint: (position: Vec2) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  world: Vec2;
}

function getRange(state: SimulationState): number {
  return state.humanPositionId === "ZFW_23" ? 88 : 58;
}

export function RadarScope({
  state,
  selectedAircraftId,
  selectedWaypointId,
  onSelectAircraft,
  onSelectWaypoint,
  onCreateWaypoint,
}: RadarScopeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      setSize({ width: Math.max(520, Math.floor(rect.width)), height: Math.max(480, Math.floor(rect.height)) });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScope(ctx, size.width, size.height, state, selectedAircraftId, selectedWaypointId);
  }, [size, state, selectedAircraftId, selectedWaypointId]);

  const screenToWorld = (clientX: number, clientY: number): Vec2 => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const range = getRange(state);
    const scale = Math.min(rect.width, rect.height) / (range * 2);
    return {
      x: (clientX - rect.left - rect.width / 2) / scale,
      y: -(clientY - rect.top - rect.height / 2) / scale,
    };
  };

  const handleClick = (clientX: number, clientY: number) => {
    setContextMenu(null);
    const world = screenToWorld(clientX, clientY);
    const custom = state.waypoints.find((waypoint) => waypoint.source === "CUSTOM" && Math.hypot(waypoint.position.x - world.x, waypoint.position.y - world.y) < 3.2);
    if (custom) {
      onSelectWaypoint(custom.id);
      onSelectAircraft(null);
      return;
    }
    const aircraft = state.aircraft.find((item) => Math.hypot(item.position.x - world.x, item.position.y - world.y) < 3.5);
    if (aircraft) {
      onSelectAircraft(aircraft.id);
      onSelectWaypoint(null);
      return;
    }
    onSelectAircraft(null);
    onSelectWaypoint(null);
  };

  return (
    <div className="radar-wrap" onClick={() => contextMenu && setContextMenu(null)}>
      <canvas
        ref={canvasRef}
        className="radar-canvas"
        onClick={(event) => {
          event.stopPropagation();
          handleClick(event.clientX, event.clientY);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setContextMenu({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            world: screenToWorld(event.clientX, event.clientY),
          });
        }}
      />
      <div className="scope-corner scope-corner-left">
        <strong>{state.humanPositionId === "ZFW_23" ? "ZFW 23 / ERAM" : "D10 / STARS"}</strong>
        <span>RANGE {getRange(state)} NM</span>
      </div>
      <div className="scope-corner scope-corner-right">
        <span>SIM {formatClock(state.simTimeSec)}</span>
        <span>{state.paused ? "PAUSED" : "LIVE"}</span>
      </div>
      {contextMenu && (
        <div className="map-context" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button
            onClick={() => {
              onCreateWaypoint(contextMenu.world);
              setContextMenu(null);
            }}
          >
            + Create Waypoint
          </button>
          <span>{contextMenu.world.x.toFixed(1)} / {contextMenu.world.y.toFixed(1)} NM</span>
        </div>
      )}
    </div>
  );
}

function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function drawScope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: SimulationState,
  selectedAircraftId: string | null,
  selectedWaypointId: string | null,
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#07100d";
  ctx.fillRect(0, 0, width, height);

  const range = getRange(state);
  const scale = Math.min(width, height) / (range * 2);
  const toScreen = (position: Vec2) => ({ x: width / 2 + position.x * scale, y: height / 2 - position.y * scale });

  drawTerrain(ctx, width, height, scale, state);
  drawRangeRings(ctx, width, height, scale, range);
  drawSector(ctx, width, height, scale, state);
  drawProcedures(ctx, state, toScreen);
  drawAirport(ctx, toScreen({ x: 0, y: 0 }), scale);
  drawWaypoints(ctx, state.waypoints, toScreen, selectedWaypointId);
  drawAircraft(ctx, state.aircraft, toScreen, selectedAircraftId, state);
}

function drawRangeRings(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, range: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(105, 160, 130, 0.15)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  const step = range > 60 ? 20 : 10;
  for (let nm = step; nm < range; nm += step) {
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, nm * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTerrain(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, state: SimulationState) {
  if (state.terrainMode === "OFF") return;
  const opacity = state.terrainMode === "SUBTLE" ? 0.07 : state.terrainMode === "SAFETY" ? 0.12 : 0.18;
  const bands = [
    { points: [[-58, -50], [-34, -48], [-20, -34], [-30, -20], [-52, -22], [-70, -36]], level: 1800 },
    { points: [[-67, 28], [-42, 42], [-25, 30], [-32, 12], [-58, 8]], level: 2200 },
    { points: [[36, -50], [62, -40], [70, -18], [48, -12], [30, -26]], level: 1200 },
  ];
  ctx.save();
  for (const band of bands) {
    ctx.beginPath();
    band.points.forEach(([x, y], index) => {
      const sx = width / 2 + x * scale;
      const sy = height / 2 - y * scale;
      if (index === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.fillStyle = `rgba(105, 126, 82, ${opacity})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(127, 149, 100, ${opacity + 0.08})`;
    ctx.stroke();
    if (state.terrainMode === "FULL") {
      const [x, y] = band.points[1];
      ctx.fillStyle = "rgba(150, 170, 120, 0.35)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(`${band.level} FT`, width / 2 + x * scale, height / 2 - y * scale);
    }
  }
  ctx.restore();
}

function drawSector(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, state: SimulationState) {
  ctx.save();
  ctx.strokeStyle = state.humanPositionId === "ZFW_23" ? "rgba(78, 160, 151, 0.32)" : "rgba(79, 180, 131, 0.32)";
  ctx.lineWidth = 1;
  if (state.humanPositionId === "ZFW_23") {
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(width / 2 - 72 * scale, height / 2 - 47 * scale, 144 * scale, 94 * scale);
  } else {
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, 49 * scale, 41 * scale, -0.15, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawProcedures(ctx: CanvasRenderingContext2D, state: SimulationState, toScreen: (position: Vec2) => Vec2) {
  const byName = new Map(state.waypoints.map((waypoint) => [waypoint.name, waypoint]));
  ctx.save();
  for (const procedure of state.procedures) {
    if (state.humanPositionId === "ZFW_23" && procedure.type !== "AIRWAY" && procedure.source !== "CUSTOM") continue;
    ctx.strokeStyle = procedure.source === "CUSTOM" ? "rgba(245, 199, 96, 0.55)" : "rgba(92, 173, 146, 0.23)";
    ctx.lineWidth = procedure.source === "CUSTOM" ? 1.4 : 1;
    ctx.setLineDash(procedure.source === "CUSTOM" ? [5, 4] : []);
    for (const leg of procedure.legs) {
      if (!leg.fromFix || !leg.toFix) continue;
      const from = byName.get(leg.fromFix);
      const to = byName.get(leg.toFix);
      if (!from || !to) continue;
      const a = toScreen(from.position);
      const b = toScreen(to.position);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawAirport(ctx: CanvasRenderingContext2D, screen: Vec2, scale: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(183, 207, 190, 0.72)";
  ctx.lineWidth = 2;
  const runway = Math.max(14, 4.8 * scale);
  ctx.beginPath();
  ctx.moveTo(screen.x - 3, screen.y - runway);
  ctx.lineTo(screen.x - 3, screen.y + runway);
  ctx.moveTo(screen.x + 3, screen.y - runway);
  ctx.lineTo(screen.x + 3, screen.y + runway);
  ctx.stroke();
  ctx.fillStyle = "rgba(183, 207, 190, 0.72)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("DFW", screen.x + 8, screen.y - 8);
  ctx.restore();
}

function drawWaypoints(ctx: CanvasRenderingContext2D, waypoints: Waypoint[], toScreen: (position: Vec2) => Vec2, selectedId: string | null) {
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";
  for (const waypoint of waypoints) {
    const p = toScreen(waypoint.position);
    const selected = waypoint.id === selectedId;
    ctx.strokeStyle = waypoint.source === "CUSTOM" ? "rgba(245, 199, 96, 0.95)" : "rgba(138, 180, 158, 0.55)";
    ctx.fillStyle = selected ? "rgba(255, 224, 139, 0.95)" : waypoint.source === "CUSTOM" ? "rgba(245, 199, 96, 0.9)" : "rgba(138, 180, 158, 0.62)";
    ctx.lineWidth = selected ? 2 : 1;
    if (waypoint.kind === "AIRPORT") continue;
    if (waypoint.source === "CUSTOM") {
      ctx.beginPath();
      ctx.moveTo(p.x - 4, p.y);
      ctx.lineTo(p.x + 4, p.y);
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x, p.y + 4);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x + 4, p.y + 3);
      ctx.lineTo(p.x - 4, p.y + 3);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillText(waypoint.name, p.x + 7, p.y - 5);
  }
  ctx.restore();
}

function drawAircraft(ctx: CanvasRenderingContext2D, aircraftList: AircraftState[], toScreen: (position: Vec2) => Vec2, selectedId: string | null, state: SimulationState) {
  ctx.save();
  ctx.font = "11px ui-monospace, monospace";
  for (const aircraft of aircraftList) {
    const p = toScreen(aircraft.position);
    const selected = aircraft.id === selectedId;
    const owned = aircraft.controllerPositionId === state.humanPositionId;
    const inbound = state.handoffs.some((handoff) => handoff.aircraftId === aircraft.id && handoff.toPosition === state.humanPositionId && handoff.status === "REQUESTED");
    const alert = state.alerts.some((item) => item.aircraftIds.includes(aircraft.id));
    const color = alert ? "#ff726d" : inbound ? "#f5c760" : owned ? "#d9ff91" : "#72b9a2";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
    const heading = (aircraft.headingDeg * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.sin(heading) * 16, p.y - Math.cos(heading) * 16);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x + 5, p.y - 5);
    ctx.lineTo(p.x + 18, p.y - 18);
    ctx.stroke();
    ctx.fillText(`${aircraft.callsign} ${aircraft.aircraftType}`, p.x + 21, p.y - 20);
    ctx.fillText(`${formatAltitude(aircraft.altitudeFt)}  ${Math.round(aircraft.speedKts)}KT`, p.x + 21, p.y - 8);
    if (selected) {
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}
