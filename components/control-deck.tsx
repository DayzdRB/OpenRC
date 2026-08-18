"use client";

import { useEffect, useMemo, useState } from "react";
import {
  formatAltitude,
  formatHeading,
  formatSpeed,
  type AircraftState,
  type Procedure,
  type Waypoint,
} from "@openrc/simulation";

interface ControlDeckProps {
  aircraft: AircraftState;
  owned: boolean;
  humanPositionType: "GROUND" | "TOWER" | "DEPARTURE" | "APPROACH" | "TRACON" | "CENTER";
  waypoints: Waypoint[];
  procedures: Procedure[];
  onHeading: (heading: number) => void;
  onAltitude: (altitudeFt: number) => void;
  onSpeed: (speedKts: number) => void;
  onDirectTo: (waypoint: string) => void;
  onAssignProcedure: (procedureId: string) => void;
  onResumeRoute: () => void;
  onHandoff: () => void;
}

const normalizeHeading = (value: number) => ((Math.round(value) % 360) + 360) % 360;

export function ControlDeck({
  aircraft,
  owned,
  humanPositionType,
  waypoints,
  procedures,
  onHeading,
  onAltitude,
  onSpeed,
  onDirectTo,
  onAssignProcedure,
  onResumeRoute,
  onHandoff,
}: ControlDeckProps) {
  const [directDraft, setDirectDraft] = useState("");
  const [procedureDraft, setProcedureDraft] = useState(aircraft.flightPlan.procedureId ?? "");

  useEffect(() => {
    setProcedureDraft(aircraft.flightPlan.procedureId ?? "");
    setDirectDraft("");
  }, [aircraft.id, aircraft.flightPlan.procedureId]);

  const availableProcedures = useMemo(() => {
    const phase = aircraft.flightPhase;
    return procedures.filter((procedure) => {
      if (procedure.type === "AIRWAY") return true;
      if (phase === "ARRIVAL" || phase === "APPROACH") return procedure.type === "STAR" || procedure.type === "APPROACH";
      if (phase === "DEPARTURE") return procedure.type === "SID";
      return procedure.type === "AIRWAY";
    });
  }, [aircraft.flightPhase, procedures]);

  const altitudePresets = humanPositionType === "CENTER"
    ? [18000, 24000, 30000, 36000, 40000]
    : [3000, 5000, 7000, 10000, 12000, 16000];

  const speedPresets = humanPositionType === "CENTER"
    ? [250, 300, 350, 400, 450]
    : [170, 190, 210, 240, 280];

  const setHeading = (value: number) => owned && onHeading(normalizeHeading(value));
  const setAltitude = (value: number) => owned && onAltitude(Math.max(0, Math.min(51000, Math.round(value / 100) * 100)));
  const setSpeed = (value: number) => owned && onSpeed(value);

  return (
    <div className={`greenlight-deck ${owned ? "" : "read-only"}`}>
      <section className="control-module heading-module">
        <div className="module-title"><span>HEADING</span><strong>{formatHeading(aircraft.assignedHeadingDeg)}</strong></div>
        <HeadingDial heading={aircraft.assignedHeadingDeg} disabled={!owned} onChange={setHeading} />
        <div className="micro-steps">
          <button disabled={!owned} onClick={() => setHeading(aircraft.assignedHeadingDeg - 10)}>−10</button>
          <button disabled={!owned} onClick={() => setHeading(aircraft.assignedHeadingDeg - 5)}>−5</button>
          <button disabled={!owned} onClick={() => setHeading(aircraft.assignedHeadingDeg + 5)}>+5</button>
          <button disabled={!owned} onClick={() => setHeading(aircraft.assignedHeadingDeg + 10)}>+10</button>
        </div>
        <div className="preset-row compact">
          {[360, 90, 180, 270].map((heading) => (
            <button key={heading} disabled={!owned} onClick={() => setHeading(heading)}>
              {String(heading).padStart(3, "0")}
            </button>
          ))}
        </div>
      </section>

      <section className="control-module value-module">
        <div className="module-title"><span>ALTITUDE</span><strong>{formatAltitude(aircraft.assignedAltitudeFt)}</strong></div>
        <div className="value-stepper">
          <button disabled={!owned} onClick={() => setAltitude(aircraft.assignedAltitudeFt - 1000)}>−</button>
          <div><b>{formatAltitude(aircraft.assignedAltitudeFt)}</b><small>{aircraft.verticalSpeedFpm === 0 ? "LEVEL" : `${aircraft.verticalSpeedFpm > 0 ? "↑" : "↓"} ${Math.abs(Math.round(aircraft.verticalSpeedFpm))} FPM`}</small></div>
          <button disabled={!owned} onClick={() => setAltitude(aircraft.assignedAltitudeFt + 1000)}>+</button>
        </div>
        <div className="preset-row">
          {altitudePresets.map((altitude) => (
            <button key={altitude} disabled={!owned} className={Math.abs(aircraft.assignedAltitudeFt - altitude) < 100 ? "chosen" : ""} onClick={() => setAltitude(altitude)}>
              {altitude >= 18000 ? `FL${String(Math.round(altitude / 100)).padStart(3, "0")}` : `${Math.round(altitude / 1000)}K`}
            </button>
          ))}
        </div>

        <div className="module-title second"><span>SPEED</span><strong>{formatSpeed(aircraft.assignedSpeedKts)}</strong></div>
        <div className="value-stepper">
          <button disabled={!owned} onClick={() => setSpeed(aircraft.assignedSpeedKts - 10)}>−</button>
          <div><b>{formatSpeed(aircraft.assignedSpeedKts)}</b><small>ACTUAL {Math.round(aircraft.speedKts)} KT</small></div>
          <button disabled={!owned} onClick={() => setSpeed(aircraft.assignedSpeedKts + 10)}>+</button>
        </div>
        <div className="preset-row">
          {speedPresets.map((speed) => (
            <button key={speed} disabled={!owned} className={Math.abs(aircraft.assignedSpeedKts - speed) < 3 ? "chosen" : ""} onClick={() => setSpeed(speed)}>
              {speed}
            </button>
          ))}
        </div>
      </section>

      <section className="control-module route-module">
        <div className="module-title"><span>NAVIGATION</span><strong>{aircraft.navigationMode}</strong></div>
        <div className="nav-action-row">
          <label>
            <span>DIRECT TO</span>
            <input
              list={`waypoints-${aircraft.id}`}
              value={directDraft}
              disabled={!owned}
              placeholder="FIX / VOR / WPT"
              onChange={(event) => setDirectDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && directDraft) onDirectTo(directDraft);
              }}
            />
            <datalist id={`waypoints-${aircraft.id}`}>
              {waypoints.slice(0, 1800).map((waypoint) => <option key={waypoint.id} value={waypoint.name}>{waypoint.kind} · {waypoint.source}</option>)}
            </datalist>
          </label>
          <button className="primary" disabled={!owned || !directDraft} onClick={() => directDraft && onDirectTo(directDraft)}>DIRECT</button>
        </div>

        <div className="nav-action-row">
          <label>
            <span>SID / STAR / AIRWAY</span>
            <select disabled={!owned} value={procedureDraft} onChange={(event) => setProcedureDraft(event.target.value)}>
              <option value="">Select procedure or airway…</option>
              {(["SID", "STAR", "APPROACH", "AIRWAY"] as const).map((type) => {
                const items = availableProcedures.filter((procedure) => procedure.type === type);
                return items.length > 0 ? (
                  <optgroup key={type} label={type}>
                    {items.slice(0, 350).map((procedure) => (
                      <option key={procedure.id} value={procedure.id}>{procedure.name} · {procedure.source}</option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          <button className="primary" disabled={!owned || !procedureDraft} onClick={() => procedureDraft && onAssignProcedure(procedureDraft)}>ASSIGN</button>
        </div>

        <div className="active-route">
          <span>ACTIVE ROUTE</span>
          <strong>{aircraft.flightPlan.route.join("  ›  ") || "VECTOR / NO ROUTE"}</strong>
          <small>{aircraft.flightPlan.procedureId
            ? procedures.find((procedure) => procedure.id === aircraft.flightPlan.procedureId)?.name ?? aircraft.flightPlan.procedureId
            : "NO ASSIGNED PROCEDURE"}</small>
        </div>

        <div className="route-buttons">
          <button disabled={!owned} onClick={onResumeRoute}>RESUME ROUTE</button>
          <button disabled={!owned} onClick={onHandoff}>HANDOFF NEXT</button>
        </div>
        {!owned && <p className="ownership-note">Observed target. Its current controller is still issuing clearances.</p>}
      </section>
    </div>
  );
}

function HeadingDial({ heading, disabled, onChange }: { heading: number; disabled: boolean; onChange: (heading: number) => void }) {
  const selectFromPointer = (clientX: number, clientY: number, element: SVGSVGElement) => {
    if (disabled) return;
    const rect = element.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
    onChange(Math.round(normalizeHeading(degrees) / 5) * 5);
  };

  return (
    <svg
      className="heading-dial"
      viewBox="0 0 120 120"
      role="slider"
      aria-label="Assigned heading"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={normalizeHeading(heading)}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={(event) => selectFromPointer(event.clientX, event.clientY, event.currentTarget)}
      onWheel={(event) => {
        if (disabled) return;
        event.preventDefault();
        onChange(heading + (event.deltaY > 0 ? 5 : -5));
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") onChange(heading - 5);
        if (event.key === "ArrowRight" || event.key === "ArrowUp") onChange(heading + 5);
      }}
    >
      <circle cx="60" cy="60" r="52" className="dial-ring" />
      {Array.from({ length: 36 }, (_, index) => {
        const angle = index * 10;
        const major = index % 3 === 0;
        const radians = (angle * Math.PI) / 180;
        const outer = 50;
        const inner = major ? 42 : 46;
        return (
          <line
            key={angle}
            x1={60 + Math.sin(radians) * inner}
            y1={60 - Math.cos(radians) * inner}
            x2={60 + Math.sin(radians) * outer}
            y2={60 - Math.cos(radians) * outer}
            className={major ? "dial-tick major" : "dial-tick"}
          />
        );
      })}
      {[
        ["N", 60, 17],
        ["E", 103, 63],
        ["S", 60, 108],
        ["W", 17, 63],
      ].map(([label, x, y]) => <text key={String(label)} x={Number(x)} y={Number(y)} textAnchor="middle" className="dial-label">{label}</text>)}
      <g transform={`rotate(${normalizeHeading(heading)} 60 60)`}>
        <line x1="60" y1="60" x2="60" y2="23" className="dial-needle" />
        <path d="M60 18 L55 29 L65 29 Z" className="dial-arrow" />
      </g>
      <circle cx="60" cy="60" r="4" className="dial-hub" />
      <text x="60" y="77" textAnchor="middle" className="dial-value">{String(normalizeHeading(heading) || 360).padStart(3, "0")}°</text>
    </svg>
  );
}
