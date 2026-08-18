import { createDemoScenario, DEMO_CENTER } from "./data";
import { clamp, distanceNm, headingTo, move, projectPosition, turnToward } from "./math";
import { SeededRng } from "./rng";
import type {
  AircraftState,
  Handoff,
  SeparationAlert,
  SimulationEvent,
  SimulationState,
  TerrainMode,
  Waypoint,
} from "./types";

const SEPARATION_RULES = {
  TERMINAL: { horizontalNm: 3, verticalFt: 1000 },
  CENTER: { horizontalNm: 5, verticalFt: 1000 },
};

export class SimulationEngine {
  private state: SimulationState;
  private rng: SeededRng;
  private eventCounter = 0;

  constructor(initialState: SimulationState = createDemoScenario()) {
    this.state = structuredClone(initialState);
    this.rng = new SeededRng(this.state.seed);
  }

  snapshot(): SimulationState {
    return structuredClone(this.state);
  }

  load(state: SimulationState): void {
    this.state = structuredClone(state);
    this.rng = new SeededRng(this.state.seed);
    this.log("SCENARIO", "Saved scenario restored.");
  }

  reset(seed = 938224): void {
    this.state = createDemoScenario(seed);
    this.rng = new SeededRng(seed);
    this.eventCounter = 0;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
  }

  setTerrainMode(mode: TerrainMode): void {
    this.state.terrainMode = mode;
  }

  setHumanPosition(positionId: string): void {
    if (!this.state.positions.some((position) => position.id === positionId)) return;
    this.state.humanPositionId = positionId;
    this.state.positions = this.state.positions.map((position) => ({
      ...position,
      staffingMode: position.id === positionId ? "HUMAN" : position.staffingMode === "COMBINED" ? "COMBINED" : "AI",
    }));
    this.log("SCENARIO", `${positionId} is now the player position; other demo positions are AI staffed.`);
  }

  issueHeading(aircraftId: string, headingDeg: number): void {
    const aircraft = this.ownedAircraft(aircraftId);
    if (!aircraft) return;
    aircraft.assignedHeadingDeg = ((Math.round(headingDeg) % 360) + 360) % 360;
    aircraft.navigationMode = "HEADING";
    this.log("COMMAND", `${aircraft.callsign}: fly heading ${String(aircraft.assignedHeadingDeg || 360).padStart(3, "0")}.`);
  }

  resumeRoute(aircraftId: string): void {
    const aircraft = this.ownedAircraft(aircraftId);
    if (!aircraft) return;
    aircraft.navigationMode = "ROUTE";
    this.log("COMMAND", `${aircraft.callsign}: resume own navigation.`);
  }

  issueAltitude(aircraftId: string, altitudeFt: number): void {
    const aircraft = this.ownedAircraft(aircraftId);
    if (!aircraft) return;
    aircraft.assignedAltitudeFt = clamp(Math.round(altitudeFt / 100) * 100, 0, 51000);
    this.log("COMMAND", `${aircraft.callsign}: altitude ${aircraft.assignedAltitudeFt} ft.`);
  }

  issueSpeed(aircraftId: string, speedKts: number): void {
    const aircraft = this.ownedAircraft(aircraftId);
    if (!aircraft) return;
    aircraft.assignedSpeedKts = clamp(Math.round(speedKts / 5) * 5, aircraft.performance.minSpeedKts, aircraft.performance.maxSpeedKts);
    this.log("COMMAND", `${aircraft.callsign}: speed ${aircraft.assignedSpeedKts} knots.`);
  }

  requestNextHandoff(aircraftId: string): void {
    const aircraft = this.ownedAircraft(aircraftId);
    if (!aircraft) return;
    const next = this.recommendedNextPosition(aircraft);
    if (next) this.createHandoff(aircraft, next);
  }

  acceptHandoff(aircraftId: string): void {
    const handoff = this.state.handoffs.find((item) => item.aircraftId === aircraftId && item.toPosition === this.state.humanPositionId && item.status === "REQUESTED");
    if (!handoff) return;
    handoff.status = "ACCEPTED";
    handoff.acceptedAtSec = this.state.simTimeSec;
    this.log("HANDOFF", `${aircraftId.toUpperCase()} handoff accepted from ${handoff.fromPosition}.`);
  }

  rejectHandoff(aircraftId: string): void {
    const handoff = this.state.handoffs.find((item) => item.aircraftId === aircraftId && item.toPosition === this.state.humanPositionId && item.status === "REQUESTED");
    if (!handoff) return;
    handoff.status = "REJECTED";
    this.log("HANDOFF", `${aircraftId.toUpperCase()} handoff rejected.`);
  }

  createCustomWaypoint(position: { x: number; y: number }, latitude: number, longitude: number): Waypoint {
    let name = "";
    const used = new Set(this.state.waypoints.map((waypoint) => waypoint.name));
    const consonants = "BCDFGHJKLMNPRSTVWZ";
    const vowels = "AEIOU";
    do {
      name = `${consonants[this.rng.integer(0, consonants.length - 1)]}${vowels[this.rng.integer(0, vowels.length - 1)]}${consonants[this.rng.integer(0, consonants.length - 1)]}${vowels[this.rng.integer(0, vowels.length - 1)]}${consonants[this.rng.integer(0, consonants.length - 1)]}`;
    } while (used.has(name));

    const waypoint: Waypoint = {
      id: `CUSTOM_${name}_${Math.round(this.state.simTimeSec * 10)}`,
      name,
      position,
      latitude,
      longitude,
      source: "CUSTOM",
      kind: "CUSTOM",
    };
    this.state.waypoints.push(waypoint);
    this.log("WAYPOINT", `Custom waypoint ${name} created.`);
    return structuredClone(waypoint);
  }

  renameCustomWaypoint(id: string, requestedName: string): boolean {
    const waypoint = this.state.waypoints.find((item) => item.id === id && item.source === "CUSTOM");
    const name = requestedName.trim().toUpperCase();
    if (!waypoint || !/^[A-Z]{5}$/.test(name)) return false;
    if (this.state.waypoints.some((item) => item.id !== id && item.name === name)) return false;
    waypoint.name = name;
    this.log("WAYPOINT", `Custom waypoint renamed to ${name}.`);
    return true;
  }

  waypointDependencies(id: string): string[] {
    const waypoint = this.state.waypoints.find((item) => item.id === id);
    if (!waypoint) return [];
    const dependencies = this.state.procedures
      .filter((procedure) => procedure.legs.some((leg) => leg.fromFix === waypoint.name || leg.toFix === waypoint.name))
      .map((procedure) => `${procedure.name} ${procedure.type}`);
    const trafficUses = this.state.aircraft.some((aircraft) => aircraft.flightPlan.route.includes(waypoint.name));
    if (trafficUses) dependencies.push("Scenario traffic");
    return dependencies;
  }

  deleteCustomWaypoint(id: string): { deleted: boolean; dependencies: string[] } {
    const waypoint = this.state.waypoints.find((item) => item.id === id && item.source === "CUSTOM");
    if (!waypoint) return { deleted: false, dependencies: [] };
    const dependencies = this.waypointDependencies(id);
    if (dependencies.length > 0) return { deleted: false, dependencies };
    this.state.waypoints = this.state.waypoints.filter((item) => item.id !== id);
    this.log("WAYPOINT", `Custom waypoint ${waypoint.name} deleted.`);
    return { deleted: true, dependencies: [] };
  }

  step(dtSec: number): void {
    if (this.state.paused || dtSec <= 0) return;
    const dt = Math.min(dtSec, 0.25);
    this.state.simTimeSec += dt;

    for (const restriction of this.state.runwayRestrictions) {
      restriction.remainingSec = Math.max(0, restriction.remainingSec - dt);
    }

    for (const aircraft of this.state.aircraft) {
      this.updateNavigation(aircraft);
      this.updateAircraftPhysics(aircraft, dt);
    }

    this.updateAutomaticHandoffs();
    this.updateHandoffStates();
    this.state.alerts = this.calculateSeparationAlerts();
  }

  private ownedAircraft(id: string): AircraftState | undefined {
    return this.state.aircraft.find((aircraft) => aircraft.id === id && aircraft.controllerPositionId === this.state.humanPositionId);
  }

  private findWaypoint(name: string): Waypoint | undefined {
    return this.state.waypoints.find((waypoint) => waypoint.name === name || waypoint.id === name);
  }

  private updateNavigation(aircraft: AircraftState): void {
    if (aircraft.navigationMode !== "ROUTE") return;
    const targetName = aircraft.flightPlan.route[aircraft.nextRouteIndex];
    const target = targetName ? this.findWaypoint(targetName) : undefined;
    if (!target) return;

    if (distanceNm(aircraft.position, target.position) < 2.2) {
      aircraft.nextRouteIndex = Math.min(aircraft.nextRouteIndex + 1, aircraft.flightPlan.route.length);
      const nextName = aircraft.flightPlan.route[aircraft.nextRouteIndex];
      const next = nextName ? this.findWaypoint(nextName) : undefined;
      if (next) aircraft.assignedHeadingDeg = headingTo(aircraft.position, next.position);
      this.applyProcedureConstraint(aircraft, nextName);
      return;
    }

    aircraft.assignedHeadingDeg = headingTo(aircraft.position, target.position);
  }

  private applyProcedureConstraint(aircraft: AircraftState, targetName?: string): void {
    if (!targetName || !aircraft.flightPlan.procedureId) return;
    const controller = this.state.positions.find((position) => position.id === aircraft.controllerPositionId);
    if (controller?.staffingMode !== "AI") return;
    const procedure = this.state.procedures.find((item) => item.id === aircraft.flightPlan.procedureId);
    const leg = procedure?.legs.find((item) => item.toFix === targetName);
    if (!leg) return;

    if (leg.altitudeRestriction) {
      const restriction = leg.altitudeRestriction;
      if (restriction.type === "AT" && restriction.minFt !== undefined) aircraft.assignedAltitudeFt = restriction.minFt;
      if (restriction.type === "AT_OR_BELOW" && restriction.maxFt !== undefined) aircraft.assignedAltitudeFt = Math.min(aircraft.assignedAltitudeFt, restriction.maxFt);
      if (restriction.type === "AT_OR_ABOVE" && restriction.minFt !== undefined) aircraft.assignedAltitudeFt = Math.max(aircraft.assignedAltitudeFt, restriction.minFt);
      if (restriction.type === "WINDOW") aircraft.assignedAltitudeFt = clamp(aircraft.assignedAltitudeFt, restriction.minFt ?? 0, restriction.maxFt ?? 51000);
    }
    if (leg.speedRestriction?.type === "MAXIMUM") aircraft.assignedSpeedKts = Math.min(aircraft.assignedSpeedKts, leg.speedRestriction.knots);
    if (leg.speedRestriction?.type === "EXACT") aircraft.assignedSpeedKts = leg.speedRestriction.knots;
  }

  private updateAircraftPhysics(aircraft: AircraftState, dtSec: number): void {
    aircraft.headingDeg = turnToward(aircraft.headingDeg, aircraft.assignedHeadingDeg, aircraft.performance.turnRateDegPerSec * dtSec);

    const speedDelta = aircraft.assignedSpeedKts - aircraft.speedKts;
    const speedRate = speedDelta >= 0 ? aircraft.performance.accelerationKtsPerSec : aircraft.performance.decelerationKtsPerSec;
    aircraft.speedKts += Math.sign(speedDelta) * Math.min(Math.abs(speedDelta), speedRate * dtSec);

    const altitudeDelta = aircraft.assignedAltitudeFt - aircraft.altitudeFt;
    const rateFpm = altitudeDelta >= 0 ? aircraft.performance.climbFpm : aircraft.performance.descentFpm;
    const maxAltitudeStep = (rateFpm / 60) * dtSec;
    const actualStep = Math.sign(altitudeDelta) * Math.min(Math.abs(altitudeDelta), maxAltitudeStep);
    aircraft.altitudeFt += actualStep;
    aircraft.verticalSpeedFpm = Math.abs(altitudeDelta) < 20 ? 0 : Math.sign(altitudeDelta) * rateFpm;

    aircraft.position = move(aircraft.position, aircraft.headingDeg, aircraft.speedKts, dtSec);
  }

  private updateAutomaticHandoffs(): void {
    for (const aircraft of this.state.aircraft) {
      if (this.state.handoffs.some((handoff) => handoff.aircraftId === aircraft.id && !["COMPLETED", "REJECTED"].includes(handoff.status))) continue;
      const distance = distanceNm(aircraft.position, { x: 0, y: 0 });
      if (aircraft.flightPhase === "ARRIVAL" && aircraft.controllerPositionId === "ZFW_23" && distance < 52) this.createHandoff(aircraft, "DFW_TRACON");
      if (aircraft.flightPhase === "ARRIVAL" && aircraft.controllerPositionId === "DFW_TRACON" && distance < 8) this.createHandoff(aircraft, "DFW_TWR");
      if (aircraft.flightPhase === "DEPARTURE" && aircraft.controllerPositionId === "DFW_TRACON" && distance > 42) this.createHandoff(aircraft, "ZFW_23");
      if (aircraft.flightPhase === "DEPARTURE" && aircraft.controllerPositionId === "DFW_TWR" && distance > 4) this.createHandoff(aircraft, "DFW_TRACON");
    }
  }

  private createHandoff(aircraft: AircraftState, toPosition: string): void {
    if (aircraft.controllerPositionId === toPosition) return;
    if (this.state.handoffs.some((handoff) => handoff.aircraftId === aircraft.id && !["COMPLETED", "REJECTED"].includes(handoff.status))) return;
    const handoff: Handoff = {
      id: `handoff-${aircraft.id}-${Math.round(this.state.simTimeSec * 10)}`,
      aircraftId: aircraft.id,
      fromPosition: aircraft.controllerPositionId,
      toPosition,
      status: "REQUESTED",
      currentAltitudeFt: aircraft.altitudeFt,
      assignedAltitudeFt: aircraft.assignedAltitudeFt,
      assignedHeadingDeg: aircraft.assignedHeadingDeg,
      assignedSpeedKts: aircraft.assignedSpeedKts,
      route: [...aircraft.flightPlan.route],
      procedureId: aircraft.flightPlan.procedureId,
      entryFix: aircraft.flightPlan.entryFix,
      exitFix: aircraft.flightPlan.exitFix,
      requestedAtSec: this.state.simTimeSec,
    };
    this.state.handoffs.push(handoff);
    this.log("HANDOFF", `${aircraft.callsign}: ${handoff.fromPosition} requested handoff to ${toPosition}.`);
  }

  private updateHandoffStates(): void {
    for (const handoff of this.state.handoffs) {
      const toPosition = this.state.positions.find((position) => position.id === handoff.toPosition);
      if (handoff.status === "REQUESTED" && toPosition?.staffingMode === "AI" && this.state.simTimeSec - handoff.requestedAtSec > 2.5) {
        handoff.status = "ACCEPTED";
        handoff.acceptedAtSec = this.state.simTimeSec;
      }
      if (handoff.status === "ACCEPTED" && handoff.acceptedAtSec !== undefined && this.state.simTimeSec - handoff.acceptedAtSec > 1.2) {
        const aircraft = this.state.aircraft.find((item) => item.id === handoff.aircraftId);
        if (aircraft) aircraft.controllerPositionId = handoff.toPosition;
        handoff.status = "COMPLETED";
        handoff.completedAtSec = this.state.simTimeSec;
        this.log("HANDOFF", `${aircraft?.callsign ?? handoff.aircraftId}: handoff completed to ${handoff.toPosition}.`);
      }
    }
    this.state.handoffs = this.state.handoffs.filter((handoff) => handoff.completedAtSec === undefined || this.state.simTimeSec - handoff.completedAtSec < 8);
  }

  private recommendedNextPosition(aircraft: AircraftState): string | undefined {
    if (aircraft.flightPhase === "ARRIVAL") {
      if (aircraft.controllerPositionId === "ZFW_23") return "DFW_TRACON";
      if (aircraft.controllerPositionId === "DFW_TRACON") return "DFW_TWR";
    }
    if (aircraft.flightPhase === "DEPARTURE") {
      if (aircraft.controllerPositionId === "DFW_TWR") return "DFW_TRACON";
      if (aircraft.controllerPositionId === "DFW_TRACON") return "ZFW_23";
    }
    return undefined;
  }

  private calculateSeparationAlerts(): SeparationAlert[] {
    const alerts: SeparationAlert[] = [];
    for (let i = 0; i < this.state.aircraft.length; i += 1) {
      for (let j = i + 1; j < this.state.aircraft.length; j += 1) {
        const a = this.state.aircraft[i];
        const b = this.state.aircraft[j];
        const horizontal = distanceNm(a.position, b.position);
        const vertical = Math.abs(a.altitudeFt - b.altitudeFt);
        const aPosition = this.state.positions.find((position) => position.id === a.controllerPositionId);
        const bPosition = this.state.positions.find((position) => position.id === b.controllerPositionId);
        const centerEnvironment = aPosition?.type === "CENTER" || bPosition?.type === "CENTER";
        const rule = centerEnvironment ? SEPARATION_RULES.CENTER : SEPARATION_RULES.TERMINAL;
        if (vertical >= rule.verticalFt + 500 && horizontal > rule.horizontalNm + 2) continue;

        let predicted = horizontal;
        let timeToConflictSec: number | null = null;
        for (let t = 15; t <= 120; t += 15) {
          const pa = projectPosition(a.position, a.headingDeg, a.speedKts, t);
          const pb = projectPosition(b.position, b.headingDeg, b.speedKts, t);
          const projected = distanceNm(pa, pb);
          predicted = Math.min(predicted, projected);
          if (timeToConflictSec === null && projected < rule.horizontalNm && vertical < rule.verticalFt) timeToConflictSec = t;
        }

        const loss = horizontal < rule.horizontalNm && vertical < rule.verticalFt;
        const warning = !loss && predicted < rule.horizontalNm && vertical < rule.verticalFt + 300;
        if (!loss && !warning) continue;
        alerts.push({
          id: `sep-${a.id}-${b.id}`,
          aircraftIds: [a.id, b.id],
          requiredHorizontalNm: rule.horizontalNm,
          currentHorizontalNm: horizontal,
          verticalSeparationFt: vertical,
          predictedHorizontalNm: predicted,
          timeToConflictSec,
          severity: loss ? "LOSS" : warning ? "WARNING" : "ADVISORY",
        });
      }
    }
    return alerts;
  }

  private log(type: SimulationEvent["type"], message: string): void {
    this.eventCounter += 1;
    this.state.eventLog.push({ id: `event-${this.eventCounter}-${Math.round(this.state.simTimeSec * 10)}`, atSec: this.state.simTimeSec, type, message });
    if (this.state.eventLog.length > 120) this.state.eventLog.shift();
  }
}

export function localToLatLon(position: { x: number; y: number }): { latitude: number; longitude: number } {
  const latitude = DEMO_CENTER.latitude + position.y / 60;
  const longitude = DEMO_CENTER.longitude + position.x / (60 * Math.cos((DEMO_CENTER.latitude * Math.PI) / 180));
  return { latitude, longitude };
}
