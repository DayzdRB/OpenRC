export type StaffingMode = "HUMAN" | "AI" | "COMBINED";
export type PositionType = "GROUND" | "TOWER" | "DEPARTURE" | "APPROACH" | "TRACON" | "CENTER";
export type FlightPhase = "GROUND" | "DEPARTURE" | "ENROUTE" | "ARRIVAL" | "APPROACH";
export type WakeCategory = "LIGHT" | "MEDIUM" | "HEAVY" | "SUPER";
export type TerrainMode = "OFF" | "SUBTLE" | "SAFETY" | "FULL";
export type NavigationMode = "ROUTE" | "HEADING";
export type HandoffStatus = "NONE" | "REQUESTED" | "ACCEPTED" | "FREQUENCY_CHANGE" | "COMPLETED" | "REJECTED";
export type ProcedureType = "SID" | "STAR" | "APPROACH" | "AIRWAY";
export type LegType = "DIRECT_TO_FIX" | "TRACK_TO_FIX" | "HEADING" | "VECTOR" | "HOLD" | "COURSE" | "RUNWAY_LEG";

export interface Vec2 {
  x: number;
  y: number;
}

export interface ControllerPosition {
  id: string;
  facilityId: string;
  name: string;
  type: PositionType;
  frequency: string;
  staffingMode: StaffingMode;
  adjacentPositions: string[];
  controlledRunways: string[];
  displayProfile: "SURFACE" | "LOCAL" | "STARS" | "ERAM";
}

export interface Waypoint {
  id: string;
  name: string;
  position: Vec2;
  latitude: number;
  longitude: number;
  source: "FAA_DEMO" | "CUSTOM" | "SCENARIO";
  kind: "FIX" | "VOR" | "AIRPORT" | "CUSTOM";
}

export interface AltitudeRestriction {
  type: "AT" | "AT_OR_ABOVE" | "AT_OR_BELOW" | "WINDOW";
  minFt?: number;
  maxFt?: number;
}

export interface SpeedRestriction {
  type: "MAXIMUM" | "MINIMUM" | "EXACT";
  knots: number;
}

export interface ProcedureLeg {
  id: string;
  fromFix?: string;
  toFix?: string;
  legType: LegType;
  altitudeRestriction?: AltitudeRestriction;
  speedRestriction?: SpeedRestriction;
  course?: number;
  distanceNm?: number;
  turnDirection?: "LEFT" | "RIGHT" | "EITHER";
}

export interface Procedure {
  id: string;
  name: string;
  type: ProcedureType;
  source: "FAA_DEMO" | "CUSTOM" | "SCENARIO";
  immutable: boolean;
  legs: ProcedureLeg[];
}

export interface FlightPlan {
  origin: string;
  actualDestination: string;
  controllerRelevantDestination: string;
  entryFix?: string;
  exitFix?: string;
  route: string[];
  procedureId?: string;
}

export interface AircraftPerformance {
  turnRateDegPerSec: number;
  accelerationKtsPerSec: number;
  decelerationKtsPerSec: number;
  climbFpm: number;
  descentFpm: number;
  minSpeedKts: number;
  maxSpeedKts: number;
}

export interface AircraftState {
  id: string;
  callsign: string;
  aircraftType: string;
  wakeCategory: WakeCategory;
  position: Vec2;
  headingDeg: number;
  assignedHeadingDeg: number;
  altitudeFt: number;
  assignedAltitudeFt: number;
  speedKts: number;
  assignedSpeedKts: number;
  verticalSpeedFpm: number;
  controllerPositionId: string;
  flightPhase: FlightPhase;
  navigationMode: NavigationMode;
  flightPlan: FlightPlan;
  nextRouteIndex: number;
  performance: AircraftPerformance;
}

export interface Handoff {
  id: string;
  aircraftId: string;
  fromPosition: string;
  toPosition: string;
  status: HandoffStatus;
  currentAltitudeFt: number;
  assignedAltitudeFt: number;
  assignedHeadingDeg: number;
  assignedSpeedKts: number;
  route: string[];
  procedureId?: string;
  entryFix?: string;
  exitFix?: string;
  requestedAtSec: number;
  acceptedAtSec?: number;
  completedAtSec?: number;
}

export interface SeparationAlert {
  id: string;
  aircraftIds: [string, string];
  requiredHorizontalNm: number;
  currentHorizontalNm: number;
  verticalSeparationFt: number;
  predictedHorizontalNm: number;
  timeToConflictSec: number | null;
  severity: "ADVISORY" | "WARNING" | "LOSS";
}

export interface RunwayRestriction {
  runway: string;
  reason: string;
  leadWake: WakeCategory;
  followWake: WakeCategory;
  remainingSec: number;
}

export interface SimulationEvent {
  id: string;
  atSec: number;
  type: "COMMAND" | "HANDOFF" | "ALERT" | "SCENARIO" | "WAYPOINT";
  message: string;
}

export interface SimulationState {
  seed: number;
  simTimeSec: number;
  paused: boolean;
  humanPositionId: string;
  positions: ControllerPosition[];
  waypoints: Waypoint[];
  procedures: Procedure[];
  aircraft: AircraftState[];
  handoffs: Handoff[];
  alerts: SeparationAlert[];
  terrainMode: TerrainMode;
  runwayRestrictions: RunwayRestriction[];
  eventLog: SimulationEvent[];
}
