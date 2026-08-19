"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  clamp,
  formatAltitude,
  headingTo,
  localToLatLon,
  type AircraftState,
  type SimulationState,
  type Vec2,
  type Waypoint,
} from "@openrc/simulation";

export interface AirportRunway {
  id: string;
  runwayId: string;
  ends: [
    { id: string; latitude: number; longitude: number; position: Vec2 },
    { id: string; latitude: number; longitude: number; position: Vec2 },
  ];
  source?: string;
}

interface RadarScopeProps {
  state: SimulationState;
  selectedAircraftId: string | null;
  selectedWaypointId: string | null;
  runways?: AirportRunway[];
  onSelectAircraft: (id: string | null) => void;
  onSelectWaypoint: (id: string | null) => void;
  onCreateWaypoint: (position: Vec2) => void;
  onDirectToWaypoint: (waypointName: string) => void;
  onVectorHeading: (heading: number) => void;
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

type WaypointFilter = "OPS" | "TERMINAL" | "ENROUTE" | "NAVAIDS" | "ALL";

interface WaypointGroups {
  active: Set<string>;
  terminal: Set<string>;
  enroute: Set<string>;
}

const USGS_3DEP = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";

function defaultRange(state: SimulationState): number {
  return state.humanPositionId === "ZFW_23" ? 110 : 58;
}

export function RadarScope({
  state,
  selectedAircraftId,
  selectedWaypointId,
  runways = [],
  onSelectAircraft,
  onSelectWaypoint,
  onCreateWaypoint,
  onDirectToWaypoint,
  onVectorHeading,
}: RadarScopeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scopeHotRef = useRef(false);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [view, setView] = useState<RadarView>({ center: { x: 0, y: 0 }, rangeNm: defaultRange(state) });
  const viewRef = useRef(view);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const panRef = useRef<{ clientX: number; clientY: number; center: Vec2; scale: number } | null>(null);
  const [terrainUrl, setTerrainUrl] = useState<string | null>(null);
  const [terrainStatus, setTerrainStatus] = useState<"OFF" | "LOADING" | "READY" | "ERROR">("LOADING");
  const [waypointFilter, setWaypointFilter] = useState<WaypointFilter>("OPS");
  const [vectorMode, setVectorMode] = useState(false);
  const [vectorPreview, setVectorPreview] = useState<Vec2 | null>(null);

  const selectedAircraft = state.aircraft.find((aircraft) => aircraft.id === selectedAircraftId);
  const selectedOwned = selectedAircraft?.controllerPositionId === state.humanPositionId;
  const waypointGroups = useMemo(() => buildWaypointGroups(state), [state.aircraft, state.procedures]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const next = { center: { x: 0, y: 0 }, rangeNm: defaultRange(state) };
    viewRef.current = next;
    setView(next);
    setContextMenu(null);
    setVectorPreview(null);
  }, [state.humanPositionId]);

  useEffect(() => {
    if (!selectedOwned) {
      setVectorMode(false);
      setVectorPreview(null);
    }
  }, [selectedAircraftId, selectedOwned]);

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
    const handleKey = (event: KeyboardEvent) => {
      if (!scopeHotRef.current || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();

      if (["w", "a", "s", "d"].includes(key)) {
        event.preventDefault();
        const current = viewRef.current;
        const step = Math.max(0.6, current.rangeNm * (event.shiftKey ? 0.16 : 0.075));
        const next = {
          ...current,
          center: {
            x: current.center.x + (key === "d" ? step : key === "a" ? -step : 0),
            y: current.center.y + (key === "w" ? step : key === "s" ? -step : 0),
          },
        };
        viewRef.current = next;
        setView(next);
        setContextMenu(null);
        return;
      }

      if (key === "v" && selectedAircraft && selectedOwned) {
        event.preventDefault();
        setVectorMode((current) => !current);
        setVectorPreview(null);
      }
      if (event.key === "Escape") {
        setVectorMode(false);
        setVectorPreview(null);
        setContextMenu(null);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedAircraft, selectedOwned]);

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
    drawScope(
      ctx,
      size.width,
      size.height,
      state,
      selectedAircraftId,
      selectedWaypointId,
      view,
      waypointFilter,
      waypointGroups,
      runways,
      vectorMode ? vectorPreview : null,
    );
  }, [size, state, selectedAircraftId, selectedWaypointId, view, waypointFilter, waypointGroups, runways, vectorMode, vectorPreview]);

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
    return state.waypoints.find((waypoint) => waypointAllowed(waypoint, waypointFilter, waypointGroups, selectedWaypointId)
      && Math.hypot(waypoint.position.x - world.x, waypoint.position.y - world.y) < toleranceNm);
  };

  const vectorSelectedAt = (world: Vec2) => {
    if (!selectedAircraft || !selectedOwned) return false;
    onVectorHeading(headingTo(selectedAircraft.position, world));
    setContextMenu(null);
    return true;
  };

  const handleClick = (clientX: number, clientY: number, shiftKey: boolean) => {
    setContextMenu(null);
    const world = screenToWorld(clientX, clientY);
    if ((vectorMode || shiftKey) && vectorSelectedAt(world)) return;

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
    <div
      className={`radar-wrap ${vectorMode ? "vector-mode" : ""}`}
      onClick={() => contextMenu && setContextMenu(null)}
      onMouseEnter={() => { scopeHotRef.current = true; }}
      onMouseLeave={() => { scopeHotRef.current = false; setVectorPreview(null); }}
    >
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
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          handleClick(event.clientX, event.clientY, event.shiftKey);
        }}
        onMouseMove={(event) => {
          if (vectorMode && selectedAircraft && selectedOwned) setVectorPreview(screenToWorld(event.clientX, event.clientY));
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
        <span>{runways.length > 0 ? `DFW · ${runways.length} FAA RUNWAYS` : "DFW · RUNWAY FALLBACK"}</span>
      </div>
      <div className="scope-corner scope-corner-right">
        <span>SIM {formatClock(state.simTimeSec)}</span>
        <span>{state.paused ? "PAUSED" : "LIVE"}</span>
      </div>

      <div className="scope-tool-strip" onClick={(event) => event.stopPropagation()}>
        <button
          className={vectorMode ? "active vector-active" : ""}
          disabled={!selectedAircraft || !selectedOwned}
          onClick={() => { setVectorMode((current) => !current); setVectorPreview(null); }}
          title="Vector selected aircraft. V toggles; Shift-click vectors immediately."
        >
          VECTOR <kbd>V</kbd>
        </button>
        <div className="waypoint-filter-control" aria-label="Waypoint display filter">
          <span>FIXES</span>
          {(["OPS", "TERMINAL", "ENROUTE", "NAVAIDS", "ALL"] as WaypointFilter[]).map((filter) => (
            <button key={filter} className={waypointFilter === filter ? "active" : ""} onClick={() => setWaypointFilter(filter)}>{filter}</button>
          ))}
        </div>
        <span className="wasd-chip"><kbd>WASD</kbd> PAN</span>
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

      {vectorMode && selectedAircraft && selectedOwned && (
        <div className="vector-banner">VECTORING {selectedAircraft.callsign} · CLICK SCOPE TO ASSIGN HEADING · ESC CANCELS</div>
      )}

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
              <button onClick={() => { onSelectWaypoint(contextWaypoint.id); setContextMenu(null); }}>Inspect waypoint</button>
            </>
          ) : (
            <>
              {selectedAircraft && selectedOwned && (
                <button className="direct-context" onClick={() => { vectorSelectedAt(contextMenu.world); setContextMenu(null); }}>
                  VECTOR {selectedAircraft.callsign} HERE
                </button>
              )}
              <button onClick={() => { onCreateWaypoint(contextMenu.world); setContextMenu(null); }}>+ Create Waypoint</button>
              <span>{contextMenu.world.x.toFixed(1)} / {contextMenu.world.y.toFixed(1)} NM</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function scaleFor(width: number, height: number, rangeNm: number): number {
  return Math.min(width, height) / (rangeNm * 2);
}

function buildWaypointGroups(state: SimulationState): WaypointGroups {
  const active = new Set<string>();
  const terminal = new Set<string>();
  const enroute = new Set<string>();

  for (const aircraft of state.aircraft) {
    for (const name of aircraft.flightPlan.route) active.add(name);
  }
  for (const procedure of state.procedures) {
    const target = procedure.type === "AIRWAY" ? enroute : terminal;
    for (const leg of procedure.legs) {
      if (leg.fromFix) target.add(leg.fromFix);
      if (leg.toFix) target.add(leg.toFix);
    }
  }
  return { active, terminal, enroute };
}

function waypointAllowed(waypoint: Waypoint, filter: WaypointFilter, groups: WaypointGroups, selectedId: string | null): boolean {
  if (waypoint.id === selectedId || waypoint.source === "CUSTOM") return true;
  if (waypoint.kind === "AIRPORT") return false;
  if (filter === "ALL") return true;
  if (filter === "NAVAIDS") return waypoint.kind === "VOR" || waypoint.kind === "NDB";
  if (filter === "TERMINAL") return groups.terminal.has(waypoint.name) || waypoint.kind === "VOR" || waypoint.kind === "NDB";
  if (filter === "ENROUTE") return groups.enroute.has(waypoint.name) || waypoint.kind === "VOR" || waypoint.kind === "NDB";
  return groups.active.has(waypoint.name) || waypoint.kind === "VOR" || waypoint.kind === "NDB";
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
  waypointFilter: WaypointFilter,
  waypointGroups: WaypointGroups,
  runways: AirportRunway[],
  vectorPreview: Vec2 | null,
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
  drawAirport(ctx, toScreen, scale, runways, view.rangeNm);
  drawWaypoints(ctx, width, height, state.waypoints, toScreen, selectedWaypointId, view.rangeNm, waypointFilter, waypointGroups);
  drawAircraft(ctx, width, height, state.aircraft, toScreen, selectedAircraftId, state);
  if (vectorPreview && selectedAircraftId) {
    const aircraft = state.aircraft.find((item) => item.id === selectedAircraftId);
    if (aircraft) drawVectorPreview(ctx, aircraft, vectorPreview, toScreen);
  }
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

function drawAirport(
  ctx: CanvasRenderingContext2D,
  toScreen: (position: Vec2) => Vec2,
  scale: number,
  runways: AirportRunway[],
  rangeNm: number,
) {
  if (runways.length === 0) {
    const screen = toScreen({ x: 0, y: 0 });
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
    return;
  }

  ctx.save();
  ctx.strokeStyle = "rgba(197, 222, 205, 0.78)";
  ctx.fillStyle = "rgba(197, 222, 205, 0.72)";
  ctx.lineCap = "butt";
  ctx.font = "8px ui-monospace, monospace";
  for (const runway of runways) {
    const a = toScreen(runway.ends[0].position);
    const b = toScreen(runway.ends[1].position);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    const halfWidth = Math.max(1.1, Math.min(3.2, scale * 0.045));
    ctx.lineWidth = Math.max(1.2, Math.min(4, scale * 0.08));
    ctx.beginPath();
    ctx.moveTo(a.x + nx * halfWidth, a.y + ny * halfWidth);
    ctx.lineTo(b.x + nx * halfWidth, b.y + ny * halfWidth);
    ctx.moveTo(a.x - nx * halfWidth, a.y - ny * halfWidth);
    ctx.lineTo(b.x - nx * halfWidth, b.y - ny * halfWidth);
    ctx.stroke();

    if (rangeNm < 34) {
      ctx.fillText(runway.ends[0].id, a.x + nx * 7, a.y + ny * 7);
      ctx.fillText(runway.ends[1].id, b.x + nx * 7, b.y + ny * 7);
    }
  }
  const center = toScreen({ x: 0, y: 0 });
  ctx.font = "9px ui-monospace, monospace";
  ctx.fillText("DFW", center.x + 6, center.y - 6);
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
  filter: WaypointFilter,
  groups: WaypointGroups,
) {
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";
  const labelCells = new Set<string>();
  const cellSize = rangeNm > 90 ? 54 : rangeNm > 45 ? 44 : 34;

  for (const waypoint of waypoints) {
    if (!waypointAllowed(waypoint, filter, groups, selectedId)) continue;
    const p = toScreen(waypoint.position);
    if (!pointVisible(p, width, height, 30)) continue;
    const selected = waypoint.id === selectedId;
    const important = selected || waypoint.source === "CUSTOM" || waypoint.kind === "VOR" || waypoint.kind === "NDB" || groups.active.has(waypoint.name);
    if (rangeNm > 160 && !important && filter !== "ALL") continue;

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

    const cell = `${Math.floor(p.x / cellSize)}:${Math.floor(p.y / cellSize)}`;
    const showLabel = important || rangeNm < 36 || (rangeNm < 90 && !labelCells.has(cell));
    if (showLabel) {
      ctx.fillText(waypoint.name, p.x + 7, p.y - 5);
      labelCells.add(cell);
    }
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

function drawVectorPreview(
  ctx: CanvasRenderingContext2D,
  aircraft: AircraftState,
  target: Vec2,
  toScreen: (position: Vec2) => Vec2,
) {
  const a = toScreen(aircraft.position);
  const b = toScreen(target);
  const heading = Math.round(headingTo(aircraft.position, target));
  ctx.save();
  ctx.strokeStyle = "rgba(217, 255, 145, .9)";
  ctx.fillStyle = "rgba(217, 255, 145, .95)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
  ctx.stroke();
  const label = `${String(heading || 360).padStart(3, "0")}°`;
  ctx.font = "800 11px ui-monospace, monospace";
  const width = ctx.measureText(label).width + 12;
  ctx.fillStyle = "rgba(6, 12, 9, .9)";
  ctx.fillRect(b.x + 8, b.y - 18, width, 18);
  ctx.strokeStyle = "rgba(217, 255, 145, .7)";
  ctx.strokeRect(b.x + 8, b.y - 18, width, 18);
  ctx.fillStyle = "rgba(217, 255, 145, .95)";
  ctx.fillText(label, b.x + 14, b.y - 5);
  ctx.restore();
}

function pointVisible(point: Vec2, width: number, height: number, margin: number): boolean {
  return point.x >= -margin && point.y >= -margin && point.x <= width + margin && point.y <= height + margin;
}

function lineCouldBeVisible(a: Vec2, b: Vec2, width: number, height: number): boolean {
  return pointVisible(a, width, height, 40) || pointVisible(b, width, height, 40)
    || (Math.min(a.x, b.x) < width && Math.max(a.x, b.x) > 0 && Math.min(a.y, b.y) < height && Math.max(a.y, b.y) > 0);
}
