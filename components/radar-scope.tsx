"use client";

import { useEffect, useRef, useState } from "react";
import {
  clamp,
  formatAltitude,
  localToLatLon,
  type AircraftState,
  type SimulationState,
  type Vec2,
  type Waypoint,
} from "@openrc/simulation";

interface RadarScopeProps {
  state: SimulationState;
  selectedAircraftId: string | null;
  selectedWaypointId: string | null;
  onSelectAircraft: (id: string | null) => void;
  onSelectWaypoint: (id: string | null) => void;
  onCreateWaypoint: (position: Vec2) => void;
  onDirectToWaypoint: (waypointName: string) => void;
}

interface RadarView {
  center: Vec2;
  rangeNm: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  world: Vec2;
  waypointId?: string;
}

const USGS_3DEP = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";

function defaultRange(state: SimulationState): number {
  return state.humanPositionId === "ZFW_23" ? 110 : 58;
}

export function RadarScope({
  state,
  selectedAircraftId,
  selectedWaypointId,
  onSelectAircraft,
  onSelectWaypoint,
  onCreateWaypoint,
  onDirectToWaypoint,
}: RadarScopeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [view, setView] = useState<RadarView>({ center: { x: 0, y: 0 }, rangeNm: defaultRange(state) });
  const viewRef = useRef(view);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const panRef = useRef<{ clientX: number; clientY: number; center: Vec2; scale: number } | null>(null);
  const [terrainUrl, setTerrainUrl] = useState<string | null>(null);
  const [terrainStatus, setTerrainStatus] = useState<"OFF" | "LOADING" | "READY" | "ERROR">("LOADING");

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const next = { center: { x: 0, y: 0 }, rangeNm: defaultRange(state) };
    viewRef.current = next;
    setView(next);
    setContextMenu(null);
  }, [state.humanPositionId]);

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

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const current = viewRef.current;
      const oldScale = scaleFor(rect.width, rect.height, current.rangeNm);
      const dx = event.clientX - rect.left - rect.width / 2;
      const dy = event.clientY - rect.top - rect.height / 2;
      const anchor = {
        x: current.center.x + dx / oldScale,
        y: current.center.y - dy / oldScale,
      };
      const nextRange = clamp(current.rangeNm * Math.exp(event.deltaY * 0.00125), 6, 260);
      const nextScale = scaleFor(rect.width, rect.height, nextRange);
      const nextView = {
        rangeNm: nextRange,
        center: {
          x: anchor.x - dx / nextScale,
          y: anchor.y + dy / nextScale,
        },
      };
      viewRef.current = nextView;
      setView(nextView);
      setContextMenu(null);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const drag = panRef.current;
      if (!drag) return;
      event.preventDefault();
      const nextView = {
        ...viewRef.current,
        center: {
          x: drag.center.x - (event.clientX - drag.clientX) / drag.scale,
          y: drag.center.y + (event.clientY - drag.clientY) / drag.scale,
        },
      };
      viewRef.current = nextView;
      setView(nextView);
    };
    const handleUp = () => {
      panRef.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  useEffect(() => {
    if (state.terrainMode === "OFF") {
      setTerrainUrl(null);
      setTerrainStatus("OFF");
      return;
    }

    setTerrainStatus("LOADING");
    const timer = window.setTimeout(() => {
      const url = buildTerrainUrl(view, size);
      const image = new Image();
      image.onload = () => {
        setTerrainUrl(url);
        setTerrainStatus("READY");
      };
      image.onerror = () => {
        setTerrainUrl(null);
        setTerrainStatus("ERROR");
      };
      image.src = url;
    }, 240);

    return () => window.clearTimeout(timer);
  }, [size, state.terrainMode, view]);

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
    drawScope(ctx, size.width, size.height, state, selectedAircraftId, selectedWaypointId, view);
  }, [size, state, selectedAircraftId, selectedWaypointId, view]);

  const screenToWorld = (clientX: number, clientY: number): Vec2 => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const current = viewRef.current;
    const scale = scaleFor(rect.width, rect.height, current.rangeNm);
    return {
      x: current.center.x + (clientX - rect.left - rect.width / 2) / scale,
      y: current.center.y - (clientY - rect.top - rect.height / 2) / scale,
    };
  };

  const findWaypointAt = (world: Vec2): Waypoint | undefined => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const scale = rect ? scaleFor(rect.width, rect.height, viewRef.current.rangeNm) : 5;
    const toleranceNm = 12 / scale;
    return state.waypoints.find((waypoint) => Math.hypot(waypoint.position.x - world.x, waypoint.position.y - world.y) < toleranceNm);
  };

  const handleClick = (clientX: number, clientY: number) => {
    setContextMenu(null);
    const world = screenToWorld(clientX, clientY);
    const rect = canvasRef.current?.getBoundingClientRect();
    const scale = rect ? scaleFor(rect.width, rect.height, viewRef.current.rangeNm) : 5;
    const waypoint = findWaypointAt(world);
    if (waypoint) {
      onSelectWaypoint(waypoint.id);
      return;
    }
    const aircraft = state.aircraft.find((item) => Math.hypot(item.position.x - world.x, item.position.y - world.y) < 13 / scale);
    if (aircraft) {
      onSelectAircraft(aircraft.id);
      onSelectWaypoint(null);
      return;
    }
    onSelectAircraft(null);
    onSelectWaypoint(null);
  };

  const selectedAircraft = state.aircraft.find((aircraft) => aircraft.id === selectedAircraftId);
  const selectedOwned = selectedAircraft?.controllerPositionId === state.humanPositionId;
  const contextWaypoint = contextMenu?.waypointId
    ? state.waypoints.find((waypoint) => waypoint.id === contextMenu.waypointId)
    : undefined;

  const zoomCenter = (factor: number) => {
    setView((current) => {
      const next = { ...current, rangeNm: clamp(current.rangeNm * factor, 6, 260) };
      viewRef.current = next;
      return next;
    });
  };

  return (
    <div className="radar-wrap" onClick={() => contextMenu && setContextMenu(null)}>
      {terrainUrl && state.terrainMode !== "OFF" && (
        <div
          className={`terrain-raster terrain-${state.terrainMode.toLowerCase()}`}
          style={{ backgroundImage: `url("${terrainUrl}")` }}
          aria-hidden="true"
        />
      )}
      <canvas
        ref={canvasRef}
        className="radar-canvas"
        onClick={(event) => {
          event.stopPropagation();
          handleClick(event.clientX, event.clientY);
        }}
        onMouseDown={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          panRef.current = {
            clientX: event.clientX,
            clientY: event.clientY,
            center: { ...viewRef.current.center },
            scale: scaleFor(rect.width, rect.height, viewRef.current.rangeNm),
          };
          setContextMenu(null);
        }}
        onAuxClick={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const world = screenToWorld(event.clientX, event.clientY);
          const waypoint = findWaypointAt(world);
          setContextMenu({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            world,
            waypointId: waypoint?.id,
          });
        }}
      />
      <div className="scope-corner scope-corner-left">
        <strong>{state.humanPositionId === "ZFW_23" ? "ZFW 23 / ERAM" : "D10 / STARS"}</strong>
        <span>RANGE {view.rangeNm.toFixed(view.rangeNm < 20 ? 1 : 0)} NM</span>
        <span>{terrainStatus === "READY" ? "USGS 3DEP CONTOURS" : terrainStatus === "ERROR" ? "TOPO UNAVAILABLE" : terrainStatus === "LOADING" ? "TOPO LOADING…" : "TERRAIN OFF"}</span>
      </div>
      <div className="scope-corner scope-corner-right">
        <span>SIM {formatClock(state.simTimeSec)}</span>
        <span>{state.paused ? "PAUSED" : "LIVE"}</span>
      </div>
      <div className="scope-zoom-controls" onClick={(event) => event.stopPropagation()}>
        <button aria-label="Zoom in" onClick={() => zoomCenter(0.72)}>+</button>
        <button aria-label="Zoom out" onClick={() => zoomCenter(1.38)}>−</button>
        <button onClick={() => {
          const next = { center: { x: 0, y: 0 }, rangeNm: defaultRange(state) };
          viewRef.current = next;
          setView(next);
        }}>RESET VIEW</button>
      </div>
      {contextMenu && (
        <div className="map-context" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          {contextWaypoint ? (
            <>
              <strong>{contextWaypoint.name}</strong>
              <span>{contextWaypoint.kind} · {contextWaypoint.source}</span>
              {selectedAircraft && selectedOwned && (
                <button
                  className="direct-context"
                  onClick={() => {
                    onDirectToWaypoint(contextWaypoint.name);
                    setContextMenu(null);
                  }}
                >
                  DIRECT {selectedAircraft.callsign} → {contextWaypoint.name}
                </button>
              )}
              <button
                onClick={() => {
                  onSelectWaypoint(contextWaypoint.id);
                  setContextMenu(null);
                }}
              >
                Inspect waypoint
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  onCreateWaypoint(contextMenu.world);
                  setContextMenu(null);
                }}
              >
                + Create Waypoint
              </button>
              <span>{contextMenu.world.x.toFixed(1)} / {contextMenu.world.y.toFixed(1)} NM</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function scaleFor(width: number, height: number, rangeNm: number): number {
  return Math.min(width, height) / (rangeNm * 2);
}

function buildTerrainUrl(view: RadarView, size: { width: number; height: number }): string {
  const scale = scaleFor(size.width, size.height, view.rangeNm);
  const halfWidthNm = size.width / (2 * scale);
  const halfHeightNm = size.height / (2 * scale);
  const southWest = localToLatLon({ x: view.center.x - halfWidthNm, y: view.center.y - halfHeightNm });
  const northEast = localToLatLon({ x: view.center.x + halfWidthNm, y: view.center.y + halfHeightNm });
  const params = new URLSearchParams({
    bbox: `${southWest.longitude},${southWest.latitude},${northEast.longitude},${northEast.latitude}`,
    bboxSR: "4326",
    imageSR: "4326",
    size: `${Math.min(1600, Math.max(640, Math.round(size.width)))},${Math.min(1200, Math.max(480, Math.round(size.height)))}`,
    format: "png32",
    transparent: "true",
    renderingRule: JSON.stringify({ rasterFunction: "Contour Smoothed 25" }),
    f: "image",
  });
  return `${USGS_3DEP}?${params.toString()}`;
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
  view: RadarView,
) {
  ctx.clearRect(0, 0, width, height);
  const scale = scaleFor(width, height, view.rangeNm);
  const toScreen = (position: Vec2) => ({
    x: width / 2 + (position.x - view.center.x) * scale,
    y: height / 2 - (position.y - view.center.y) * scale,
  });

  drawRangeRings(ctx, toScreen({ x: 0, y: 0 }), scale, view.rangeNm);
  drawSector(ctx, toScreen, scale, state);
  drawProcedures(ctx, width, height, state, toScreen);
  drawAirport(ctx, toScreen({ x: 0, y: 0 }), scale);
  drawWaypoints(ctx, width, height, state.waypoints, toScreen, selectedWaypointId, view.rangeNm);
  drawAircraft(ctx, width, height, state.aircraft, toScreen, selectedAircraftId, state);
}

function drawRangeRings(ctx: CanvasRenderingContext2D, center: Vec2, scale: number, range: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(105, 160, 130, 0.15)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  const step = range > 120 ? 40 : range > 60 ? 20 : range < 20 ? 5 : 10;
  for (let nm = step; nm < range * 2; nm += step) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, nm * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSector(ctx: CanvasRenderingContext2D, toScreen: (position: Vec2) => Vec2, scale: number, state: SimulationState) {
  ctx.save();
  ctx.strokeStyle = state.humanPositionId === "ZFW_23" ? "rgba(78, 160, 151, 0.32)" : "rgba(79, 180, 131, 0.32)";
  ctx.lineWidth = 1;
  if (state.humanPositionId === "ZFW_23") {
    ctx.setLineDash([8, 5]);
    const a = toScreen({ x: -72, y: 47 });
    ctx.strokeRect(a.x, a.y, 144 * scale, 94 * scale);
  } else {
    const center = toScreen({ x: 0, y: 0 });
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, 49 * scale, 41 * scale, -0.15, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawProcedures(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: SimulationState,
  toScreen: (position: Vec2) => Vec2,
) {
  const byName = new Map(state.waypoints.map((waypoint) => [waypoint.name, waypoint]));
  const activeIds = new Set(state.aircraft.map((aircraft) => aircraft.flightPlan.procedureId).filter(Boolean));
  ctx.save();
  for (const procedure of state.procedures) {
    const active = activeIds.has(procedure.id);
    if (!active && procedure.source === "FAA" && procedure.type !== "AIRWAY") continue;
    if (!active && state.humanPositionId !== "ZFW_23" && procedure.type === "AIRWAY" && procedure.source === "FAA") continue;
    ctx.strokeStyle = active
      ? "rgba(217, 255, 145, 0.48)"
      : procedure.source === "CUSTOM"
        ? "rgba(245, 199, 96, 0.55)"
        : "rgba(92, 173, 146, 0.20)";
    ctx.lineWidth = active ? 1.5 : procedure.source === "CUSTOM" ? 1.4 : 1;
    ctx.setLineDash(procedure.source === "CUSTOM" ? [5, 4] : []);
    for (const leg of procedure.legs) {
      if (!leg.fromFix || !leg.toFix) continue;
      const from = byName.get(leg.fromFix);
      const to = byName.get(leg.toFix);
      if (!from || !to) continue;
      const a = toScreen(from.position);
      const b = toScreen(to.position);
      if (!lineCouldBeVisible(a, b, width, height)) continue;
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

function drawWaypoints(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waypoints: Waypoint[],
  toScreen: (position: Vec2) => Vec2,
  selectedId: string | null,
  rangeNm: number,
) {
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";
  for (const waypoint of waypoints) {
    if (waypoint.kind === "AIRPORT") continue;
    const p = toScreen(waypoint.position);
    if (!pointVisible(p, width, height, 30)) continue;
    const selected = waypoint.id === selectedId;
    const important = selected || waypoint.source === "CUSTOM" || waypoint.kind === "VOR" || waypoint.kind === "NDB";
    if (rangeNm > 135 && !important) continue;

    ctx.strokeStyle = waypoint.source === "CUSTOM" ? "rgba(245, 199, 96, 0.95)" : waypoint.source === "FAA" ? "rgba(139, 194, 166, 0.64)" : "rgba(138, 180, 158, 0.52)";
    ctx.fillStyle = selected ? "rgba(255, 224, 139, 0.95)" : waypoint.source === "CUSTOM" ? "rgba(245, 199, 96, 0.9)" : "rgba(138, 180, 158, 0.66)";
    ctx.lineWidth = selected ? 2 : 1;
    if (waypoint.source === "CUSTOM") {
      ctx.beginPath();
      ctx.moveTo(p.x - 4, p.y);
      ctx.lineTo(p.x + 4, p.y);
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x, p.y + 4);
      ctx.stroke();
    } else if (waypoint.kind === "VOR" || waypoint.kind === "NDB") {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x + 4, p.y + 3);
      ctx.lineTo(p.x - 4, p.y + 3);
      ctx.closePath();
      ctx.stroke();
    }
    if (rangeNm < 100 || important) ctx.fillText(waypoint.name, p.x + 7, p.y - 5);
  }
  ctx.restore();
}

function drawAircraft(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  aircraftList: AircraftState[],
  toScreen: (position: Vec2) => Vec2,
  selectedId: string | null,
  state: SimulationState,
) {
  ctx.save();
  ctx.font = "11px ui-monospace, monospace";
  for (const aircraft of aircraftList) {
    const p = toScreen(aircraft.position);
    if (!pointVisible(p, width, height, 100)) continue;
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
    ctx.fillText(`${aircraft.callsign} ${aircraft.aircraftType}`, p.x + 21, p.y - 19);
    ctx.fillText(`${formatAltitude(aircraft.altitudeFt)}  ${Math.round(aircraft.speedKts)}KT`, p.x + 21, p.y - 7);
    if (selected) {
      ctx.strokeStyle = "rgba(217,255,145,.5)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function pointVisible(point: Vec2, width: number, height: number, margin: number): boolean {
  return point.x >= -margin && point.y >= -margin && point.x <= width + margin && point.y <= height + margin;
}

function lineCouldBeVisible(a: Vec2, b: Vec2, width: number, height: number): boolean {
  return pointVisible(a, width, height, 40) || pointVisible(b, width, height, 40)
    || (Math.min(a.x, b.x) < width && Math.max(a.x, b.x) > 0 && Math.min(a.y, b.y) < height && Math.max(a.y, b.y) > 0);
}
