"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SimulationEngine,
  compactStripLines,
  formatAltitude,
  formatHeading,
  formatSpeed,
  localToLatLon,
  type NormalizedNavigationDataset,
  type Procedure,
  type SimulationState,
  type TerrainMode,
  type Vec2,
} from "@openrc/simulation";
import { ControlDeck } from "./control-deck";
import { RadarScope } from "./radar-scope";

const STORAGE_KEY = "openrc.demo.scenario.v2";

export function AtcSimulator() {
  const engineRef = useRef<SimulationEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new SimulationEngine();
  const engine = engineRef.current;
  const faaDatasetRef = useRef<NormalizedNavigationDataset | null>(null);
  const radarTickRef = useRef(0);

  const [state, setState] = useState<SimulationState>(() => engine.snapshot());
  const [selectedAircraftId, setSelectedAircraftId] = useState<string | null>("fdx1205");
  const [selectedWaypointId, setSelectedWaypointId] = useState<string | null>(null);
  const [waypointNameDraft, setWaypointNameDraft] = useState("");
  const [notice, setNotice] = useState("Simulation initialized. Select an aircraft, then right-click a fix to issue Direct-To.");
  const [procedureId, setProcedureId] = useState("JEN9-DEMO");
  const [procedureNameDraft, setProcedureNameDraft] = useState("");
  const [procedureFixDraft, setProcedureFixDraft] = useState("JEN");

  const refresh = useCallback(() => setState(engine.snapshot()), [engine]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/faa/dfw.json", { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`FAA dataset HTTP ${response.status}`);
        return response.json() as Promise<NormalizedNavigationDataset>;
      })
      .then((dataset) => {
        faaDatasetRef.current = dataset;
        engine.importNavigationData(dataset);
        setNotice(
          dataset.meta.status === "READY"
            ? `FAA NASR ${dataset.meta.cycle} loaded: ${dataset.meta.waypointCount} nearby navigation points and ${dataset.meta.airwayCount} airways.`
            : "FAA sync was unavailable during this build. OpenRC is using its clearly marked demo fallback.",
        );
        refresh();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setNotice(`FAA dataset could not be loaded in this session (${error instanceof Error ? error.message : "unknown error"}). Demo fallback remains active.`);
      });
    return () => controller.abort();
  }, [engine, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      engine.step(0.1);
      radarTickRef.current += 1;
      if (radarTickRef.current % 2 === 0) setState(engine.snapshot());
    }, 100);
    return () => window.clearInterval(timer);
  }, [engine]);

  const selectedAircraft = state.aircraft.find((aircraft) => aircraft.id === selectedAircraftId) ?? null;
  const selectedWaypoint = state.waypoints.find((waypoint) => waypoint.id === selectedWaypointId) ?? null;
  const selectedProcedure = state.procedures.find((procedure) => procedure.id === procedureId) ?? state.procedures[0];
  const humanPosition = state.positions.find((position) => position.id === state.humanPositionId);
  const selectedOwned = selectedAircraft?.controllerPositionId === state.humanPositionId;

  useEffect(() => {
    setWaypointNameDraft(selectedWaypoint?.name ?? "");
  }, [selectedWaypoint?.id, selectedWaypoint?.name]);

  useEffect(() => {
    setProcedureNameDraft(selectedProcedure?.name ?? "");
  }, [selectedProcedure?.id, selectedProcedure?.name]);

  const incomingHandoffs = useMemo(
    () => state.handoffs.filter((handoff) => handoff.toPosition === state.humanPositionId && handoff.status === "REQUESTED"),
    [state.handoffs, state.humanPositionId],
  );

  const visibleAircraft = useMemo(() => {
    const relevant = new Set<string>();
    for (const aircraft of state.aircraft) if (aircraft.controllerPositionId === state.humanPositionId) relevant.add(aircraft.id);
    for (const handoff of state.handoffs) {
      if ((handoff.toPosition === state.humanPositionId || handoff.fromPosition === state.humanPositionId) && handoff.status !== "COMPLETED") relevant.add(handoff.aircraftId);
    }
    return state.aircraft.filter((aircraft) => relevant.has(aircraft.id));
  }, [state.aircraft, state.handoffs, state.humanPositionId]);

  const createWaypoint = (position: Vec2) => {
    const { latitude, longitude } = localToLatLon(position);
    const waypoint = engine.createCustomWaypoint(position, latitude, longitude);
    setSelectedWaypointId(waypoint.id);
    setNotice(`${waypoint.name} created. Left-click it any time to edit it.`);
    refresh();
  };

  const directSelectedTo = (waypointName: string) => {
    if (!selectedAircraft) return;
    const ok = engine.directToWaypoint(selectedAircraft.id, waypointName);
    setNotice(ok ? `${selectedAircraft.callsign} cleared direct ${waypointName.toUpperCase()}.` : `${waypointName.toUpperCase()} is not available or ${selectedAircraft.callsign} is not owned by this position.`);
    refresh();
  };

  const assignSelectedProcedure = (assignedProcedureId: string) => {
    if (!selectedAircraft) return;
    const procedure = state.procedures.find((item) => item.id === assignedProcedureId);
    const ok = engine.assignProcedure(selectedAircraft.id, assignedProcedureId);
    setNotice(ok && procedure ? `${selectedAircraft.callsign} assigned ${procedure.name} ${procedure.type}.` : "That procedure cannot be assigned to the selected aircraft.");
    refresh();
  };

  const saveScenario = () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(engine.snapshot()));
    setNotice("Scenario snapshot saved locally in this browser.");
  };

  const loadScenario = () => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      setNotice("No saved OpenRC scenario exists in this browser yet.");
      return;
    }
    try {
      engine.load(JSON.parse(raw) as SimulationState);
      if (faaDatasetRef.current) engine.importNavigationData(faaDatasetRef.current);
      setNotice("Saved scenario restored. Current FAA navigation overlay reapplied.");
      refresh();
    } catch {
      setNotice("The saved scenario could not be loaded.");
    }
  };

  const resetScenario = () => {
    engine.reset();
    if (faaDatasetRef.current) engine.importNavigationData(faaDatasetRef.current);
    setSelectedAircraftId("fdx1205");
    setSelectedWaypointId(null);
    setNotice("Scenario reset. Current navigation dataset retained.");
    refresh();
  };

  const duplicateProcedure = () => {
    if (!selectedProcedure) return;
    const snapshot = engine.snapshot();
    const suffix = snapshot.procedures.filter((procedure) => procedure.source === "CUSTOM").length + 1;
    const copy: Procedure = {
      ...structuredClone(selectedProcedure),
      id: `CUSTOM-${selectedProcedure.id}-${suffix}`,
      name: `${selectedProcedure.name.replace(" DEMO", "")} C${suffix}`,
      source: "CUSTOM",
      immutable: false,
      legs: selectedProcedure.legs.map((leg, index) => ({ ...leg, id: `custom-${suffix}-${index + 1}` })),
    };
    snapshot.procedures.push(copy);
    engine.load(snapshot);
    setProcedureId(copy.id);
    setNotice(`${selectedProcedure.name} duplicated as editable custom procedure ${copy.name}.`);
    refresh();
  };

  const mutateSelectedProcedure = (mutator: (procedure: Procedure) => void) => {
    if (!selectedProcedure || selectedProcedure.immutable) return;
    const snapshot = engine.snapshot();
    const target = snapshot.procedures.find((procedure) => procedure.id === selectedProcedure.id);
    if (!target) return;
    mutator(target);
    engine.load(snapshot);
    refresh();
  };

  const renameProcedure = () => {
    const name = procedureNameDraft.trim().toUpperCase();
    if (!name) return;
    mutateSelectedProcedure((procedure) => { procedure.name = name; });
    setNotice(`Custom procedure renamed to ${name}.`);
  };

  const addDirectLeg = () => {
    if (!selectedProcedure || selectedProcedure.immutable) return;
    const fix = procedureFixDraft.trim().toUpperCase();
    if (!state.waypoints.some((waypoint) => waypoint.name === fix)) {
      setNotice(`${fix} is not a known waypoint.`);
      return;
    }
    mutateSelectedProcedure((procedure) => {
      const fromFix = procedure.legs.at(-1)?.toFix;
      procedure.legs.push({
        id: `${procedure.id}-leg-${procedure.legs.length + 1}`,
        fromFix,
        toFix: fix,
        legType: "DIRECT_TO_FIX",
      });
    });
    setNotice(`${fix} added to ${selectedProcedure.name}.`);
  };

  const removeLastLeg = () => {
    if (!selectedProcedure || selectedProcedure.immutable || selectedProcedure.legs.length === 0) return;
    mutateSelectedProcedure((procedure) => { procedure.legs.pop(); });
    setNotice(`Last leg removed from ${selectedProcedure.name}.`);
  };

  return (
    <main className="sim-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">ORC</span>
          <div>
            <strong>OpenRC</strong>
            <span>Open Radar Control · vertical slice 0.2</span>
          </div>
        </div>
        <div className="position-switch" aria-label="Player position">
          <span>PLAYER POSITION</span>
          <button className={state.humanPositionId === "DFW_TRACON" ? "active" : ""} onClick={() => { engine.setHumanPosition("DFW_TRACON"); refresh(); }}>D10 TRACON</button>
          <button className={state.humanPositionId === "ZFW_23" ? "active" : ""} onClick={() => { engine.setHumanPosition("ZFW_23"); refresh(); }}>ZFW 23 CENTER</button>
        </div>
        <div className="top-actions">
          <button onClick={() => { engine.setPaused(!state.paused); refresh(); }}>{state.paused ? "Resume" : "Pause"}</button>
          <button onClick={saveScenario}>Save</button>
          <button onClick={loadScenario}>Load</button>
          <button onClick={resetScenario}>Reset</button>
        </div>
      </header>

      <section className="status-ribbon">
        <span className="status-live"><i /> {state.paused ? "SIM PAUSED" : "SIM RUNNING"}</span>
        <span>SEED {state.seed}</span>
        <span>{humanPosition?.frequency} MHz</span>
        <span>{incomingHandoffs.length} INBOUND HANDOFF{incomingHandoffs.length === 1 ? "" : "S"}</span>
        <span>{state.alerts.length} CONFLICT{state.alerts.length === 1 ? "" : "S"}</span>
        <span className={state.navigationData.status === "READY" ? "faa-ready" : "demo-warning"}>
          {state.navigationData.status === "READY"
            ? `${state.navigationData.provider} · ${state.navigationData.cycle} · ${state.navigationData.waypointCount} WPTS`
            : "DEMO NAV FALLBACK · FAA SYNC PENDING"}
        </span>
      </section>

      <div className="workspace">
        <section className="scope-panel">
          <RadarScope
            state={state}
            selectedAircraftId={selectedAircraftId}
            selectedWaypointId={selectedWaypointId}
            onSelectAircraft={(id) => {
              setSelectedAircraftId(id);
              if (id) setSelectedWaypointId(null);
            }}
            onSelectWaypoint={setSelectedWaypointId}
            onCreateWaypoint={createWaypoint}
            onDirectToWaypoint={directSelectedTo}
          />
          <div className="scope-toolbar">
            <div className="terrain-control">
              <span>TERRAIN</span>
              {(["OFF", "SUBTLE", "SAFETY", "FULL"] as TerrainMode[]).map((mode) => (
                <button key={mode} className={state.terrainMode === mode ? "active" : ""} onClick={() => { engine.setTerrainMode(mode); refresh(); }}>{mode}</button>
              ))}
            </div>
            <div className="scope-hint">Wheel = smooth zoom · Middle-drag = pan · Right-click fix = Direct-To · Right-click empty map = Create Waypoint</div>
          </div>
        </section>

        <aside className="right-rail">
          <section className="rail-card strips-card">
            <div className="rail-heading">
              <div><span>FLIGHT STRIPS</span><strong>{visibleAircraft.length}</strong></div>
              <small>{state.humanPositionId === "ZFW_23" ? "CENTER" : "APP / DEP"}</small>
            </div>
            <div className="strip-list">
              {visibleAircraft.map((aircraft) => {
                const lines = compactStripLines(aircraft);
                const incoming = incomingHandoffs.some((handoff) => handoff.aircraftId === aircraft.id);
                const alert = state.alerts.some((item) => item.aircraftIds.includes(aircraft.id));
                return (
                  <button
                    key={aircraft.id}
                    className={`flight-strip ${selectedAircraftId === aircraft.id ? "selected" : ""} ${incoming ? "incoming" : ""} ${alert ? "alert" : ""}`}
                    onClick={() => { setSelectedAircraftId(aircraft.id); setSelectedWaypointId(null); }}
                  >
                    <span className="strip-top"><strong>{lines[0]}</strong><b>{lines[1]}</b></span>
                    <span>{lines[2]}</span>
                    <span className="strip-destination">{lines[3]}</span>
                  </button>
                );
              })}
              {visibleAircraft.length === 0 && <p className="empty-state">No aircraft currently owned by this position. AI continues running the surrounding system.</p>}
            </div>
          </section>

          <section className="rail-card command-card">
            <div className="rail-heading"><div><span>CONTROL</span><strong>{selectedAircraft?.callsign ?? "NO TARGET"}</strong></div></div>
            {selectedAircraft ? (
              <>
                <div className="aircraft-summary">
                  <span>{selectedAircraft.aircraftType}</span>
                  <span>{formatHeading(selectedAircraft.headingDeg)}</span>
                  <span>{formatAltitude(selectedAircraft.altitudeFt)}</span>
                  <span>{formatSpeed(selectedAircraft.speedKts)}</span>
                </div>
                <ControlDeck
                  aircraft={selectedAircraft}
                  owned={Boolean(selectedOwned)}
                  humanPositionType={humanPosition?.type ?? "TRACON"}
                  waypoints={state.waypoints}
                  procedures={state.procedures}
                  onHeading={(heading) => { engine.issueHeading(selectedAircraft.id, heading); refresh(); }}
                  onAltitude={(altitude) => { engine.issueAltitude(selectedAircraft.id, altitude); refresh(); }}
                  onSpeed={(speed) => { engine.issueSpeed(selectedAircraft.id, speed); refresh(); }}
                  onDirectTo={directSelectedTo}
                  onAssignProcedure={assignSelectedProcedure}
                  onResumeRoute={() => { engine.resumeRoute(selectedAircraft.id); refresh(); }}
                  onHandoff={() => { engine.requestNextHandoff(selectedAircraft.id); refresh(); }}
                />
                {incomingHandoffs.some((handoff) => handoff.aircraftId === selectedAircraft.id) && (
                  <div className="handoff-box">
                    <strong>INBOUND HANDOFF</strong>
                    <span>From {incomingHandoffs.find((handoff) => handoff.aircraftId === selectedAircraft.id)?.fromPosition}</span>
                    <div><button className="primary" onClick={() => { engine.acceptHandoff(selectedAircraft.id); refresh(); }}>Accept</button><button onClick={() => { engine.rejectHandoff(selectedAircraft.id); refresh(); }}>Reject</button></div>
                  </div>
                )}
              </>
            ) : <p className="empty-state">Select an aircraft on the scope or from a strip. Then use the direct manipulation controls here.</p>}
          </section>
        </aside>
      </div>

      <div className="lower-deck">
        <section className="lower-card alerts-card">
          <div className="lower-heading"><span>SEPARATION / RUNWAY</span><strong>{state.alerts.length ? "ACTION" : "MONITOR"}</strong></div>
          {state.alerts.length > 0 ? state.alerts.map((alert) => (
            <div className={`alert-row ${alert.severity.toLowerCase()}`} key={alert.id}>
              <strong>{alert.severity}</strong>
              <span>{alert.aircraftIds.map((id) => state.aircraft.find((aircraft) => aircraft.id === id)?.callsign ?? id).join(" / ")}</span>
              <span>{alert.currentHorizontalNm.toFixed(1)} NM · {Math.round(alert.verticalSeparationFt)} FT</span>
              <span>MIN {alert.predictedHorizontalNm.toFixed(1)} NM{alert.timeToConflictSec ? ` / ${alert.timeToConflictSec}s` : ""}</span>
            </div>
          )) : <p className="quiet-state">No predicted losses of modeled separation.</p>}
          {state.runwayRestrictions.map((restriction) => (
            <div className="runway-row" key={restriction.runway}>
              <div><strong>RWY {restriction.runway}</strong><span>{restriction.reason}</span></div>
              <div><small>NEXT ELIGIBLE</small><strong>{formatCountdown(restriction.remainingSec)}</strong></div>
            </div>
          ))}
        </section>

        <section className="lower-card waypoint-card">
          <div className="lower-heading"><span>WAYPOINT</span><strong>{selectedWaypoint?.name ?? "NONE"}</strong></div>
          {selectedWaypoint ? (
            <>
              <div className="coordinate-readout"><span>LAT {selectedWaypoint.latitude.toFixed(5)}</span><span>LON {selectedWaypoint.longitude.toFixed(5)}</span></div>
              <div className="source-badge">{selectedWaypoint.kind} · {selectedWaypoint.source}{selectedWaypoint.source === "CUSTOM" ? " · EDITABLE" : " · READ ONLY"}</div>
              {selectedWaypoint.source === "CUSTOM" ? (
                <>
                  <label className="full-input">FIVE-LETTER NAME<input value={waypointNameDraft} onChange={(event) => setWaypointNameDraft(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5))} /></label>
                  <div className="inline-actions">
                    <button className="primary" onClick={() => {
                      const ok = engine.renameCustomWaypoint(selectedWaypoint.id, waypointNameDraft);
                      setNotice(ok ? `Waypoint renamed to ${waypointNameDraft}.` : "Waypoint names must be unique and exactly five letters.");
                      refresh();
                    }}>Rename</button>
                    <button onClick={() => {
                      const result = engine.deleteCustomWaypoint(selectedWaypoint.id);
                      if (result.deleted) { setSelectedWaypointId(null); setNotice("Custom waypoint deleted."); }
                      else setNotice(`Cannot delete: ${result.dependencies.join(", ") || "waypoint is unavailable"}.`);
                      refresh();
                    }}>Delete</button>
                  </div>
                </>
              ) : (
                <button className="primary full-button" disabled={!selectedAircraft || !selectedOwned} onClick={() => directSelectedTo(selectedWaypoint.name)}>
                  DIRECT {selectedAircraft?.callsign ?? "AIRCRAFT"} → {selectedWaypoint.name}
                </button>
              )}
            </>
          ) : <p className="quiet-state">Left-click any fix to inspect it. Right-click empty scope to create a custom waypoint.</p>}
        </section>

        <section className="lower-card procedure-card">
          <div className="lower-heading"><span>PROCEDURE LAB</span><strong>{selectedProcedure?.source ?? "—"}</strong></div>
          <select value={selectedProcedure?.id ?? ""} onChange={(event) => setProcedureId(event.target.value)}>
            {state.procedures.slice(0, 700).map((procedure) => <option key={procedure.id} value={procedure.id}>{procedure.name} · {procedure.type} · {procedure.source}{procedure.immutable ? " · LOCKED" : ""}</option>)}
          </select>
          {selectedProcedure && (
            <>
              <div className="procedure-route">{selectedProcedure.legs.map((leg) => leg.toFix ?? leg.legType).join("  ›  ") || "No legs"}</div>
              {selectedProcedure.immutable ? (
                <button className="primary full-button" onClick={duplicateProcedure}>Duplicate as Custom Procedure</button>
              ) : (
                <>
                  <label className="full-input">NAME<input value={procedureNameDraft} onChange={(event) => setProcedureNameDraft(event.target.value)} /></label>
                  <div className="inline-actions"><button onClick={renameProcedure}>Rename</button><button onClick={removeLastLeg}>Remove last leg</button></div>
                  <div className="leg-builder"><input value={procedureFixDraft} onChange={(event) => setProcedureFixDraft(event.target.value.toUpperCase())} placeholder="FIX" /><button className="primary" onClick={addDirectLeg}>Add direct leg</button></div>
                </>
              )}
            </>
          )}
        </section>

        <section className="lower-card event-card">
          <div className="lower-heading"><span>CONTROLLER LOG</span><strong>{state.eventLog.length}</strong></div>
          <div className="event-list">
            {[...state.eventLog].slice(-7).reverse().map((event) => <div key={event.id}><time>{formatSimTime(event.atSec)}</time><span>{event.message}</span></div>)}
          </div>
        </section>
      </div>

      <footer className="notice-bar"><span>OPENRC</span><p>{notice}</p><b>$0 REQUIRED SERVICES · FAA/USGS PUBLIC DATA</b></footer>
    </main>
  );
}

function formatCountdown(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function formatSimTime(seconds: number): string {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
