import { mkdir, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";

const DFW = { latitude: 32.8998, longitude: -97.0403 };
const RADIUS_NM = 185;
const GROUPS = ["APT", "FIX", "NAV", "AWY", "STAR", "DP"];
const BEST_EFFORT = process.argv.includes("--best-effort");
const outputPath = new URL("../public/data/faa/dfw.json", import.meta.url);

const effective = currentNasrCycle(new Date());
const dateSlug = `${String(effective.getUTCDate()).padStart(2, "0")}_${monthAbbr(effective.getUTCMonth())}_${effective.getUTCFullYear()}`;
const cycle = effective.toISOString().slice(0, 10);
const yy = String(effective.getUTCFullYear()).slice(-2);
const mm = String(effective.getUTCMonth() + 1).padStart(2, "0");
const dd = String(effective.getUTCDate()).padStart(2, "0");
const groupUrl = (group) => `https://nfdc.faa.gov/webContent/28DaySub/extra/${dateSlug}_${group}_CSV.zip`;
const cifpUrl = `https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_${yy}${mm}${dd}.zip`;

const diagnostics = [];
const tables = new Map();

console.log(`[OpenRC FAA] Syncing NASR cycle ${cycle} for the DFW regional dataset.`);

const downloads = await Promise.allSettled(GROUPS.map(async (group) => {
  const url = groupUrl(group);
  const response = await fetch(url, {
    headers: { "user-agent": "OpenRC/0.2 FAA NASR build importer" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${group} HTTP ${response.status}`);
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const csvEntries = Object.entries(zip).filter(([name]) => name.toLowerCase().endsWith(".csv"));
  if (csvEntries.length === 0) throw new Error(`${group} archive contained no CSV files`);

  const rows = [];
  const headerSets = [];
  for (const [name, bytes] of csvEntries) {
    const text = new TextDecoder("utf-8").decode(bytes);
    try {
      const parsed = parse(text, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
      });
      if (parsed.length > 0) {
        rows.push(...parsed);
        if (headerSets.length < 3) headerSets.push({ name, headers: Object.keys(parsed[0]).slice(0, 45) });
      }
    } catch (error) {
      diagnostics.push(`${group}/${name}: CSV parse failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  console.log(`[OpenRC FAA] ${group}: ${rows.length} records from ${csvEntries.length} CSV file(s).`);
  for (const sample of headerSets) console.log(`[OpenRC FAA] ${group}/${sample.name} headers: ${sample.headers.join(" | ")}`);
  return { group, rows, url };
}));

const sourceUrls = [];
for (let index = 0; index < downloads.length; index += 1) {
  const result = downloads[index];
  const group = GROUPS[index];
  if (result.status === "fulfilled") {
    tables.set(group, result.value.rows);
    sourceUrls.push(result.value.url);
  } else {
    const message = `${group}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
    diagnostics.push(message);
    console.warn(`[OpenRC FAA] ${message}`);
  }
}

sourceUrls.push(cifpUrl);

const waypointMap = new Map();
for (const row of tables.get("APT") ?? []) {
  const name = normalizeIdentifier(pick(row, [
    "ARPT_ID", "AIRPORT_ID", "AIRPORT_IDENTIFIER", "LOCATION_IDENTIFIER", "LOC_ID", "FACILITY_IDENTIFIER",
  ]));
  addWaypoint(row, name, "AIRPORT", "APT");
}
for (const row of tables.get("FIX") ?? []) {
  const name = normalizeIdentifier(pick(row, [
    "FIX_ID", "FIX_IDENTIFIER", "FIXIDENTIFIER", "FIX_NAME", "FIXNAME", "WAYPOINT_ID", "WAYPOINT_IDENTIFIER",
  ]));
  addWaypoint(row, name, "FIX", "FIX");
}
for (const row of tables.get("NAV") ?? []) {
  const name = normalizeIdentifier(pick(row, [
    "NAV_ID", "NAVAID_ID", "NAVAID_IDENTIFIER", "NAV_IDENTIFIER", "FACILITY_IDENTIFIER", "IDENTIFIER",
  ]));
  const navType = String(pick(row, ["NAV_TYPE", "NAVAID_TYPE", "FACILITY_TYPE", "TYPE"]) ?? "").toUpperCase();
  addWaypoint(row, name, navType.includes("NDB") ? "NDB" : "VOR", "NAV");
}

function addWaypoint(row, name, kind, group) {
  if (!name || name.length > 8) return;
  const latitude = findCoordinate(row, "LAT");
  const longitude = findCoordinate(row, "LON");
  if (latitude === null || longitude === null) return;
  if (distanceNm(latitude, longitude, DFW.latitude, DFW.longitude) > RADIUS_NM) return;
  const position = latLonToLocal(latitude, longitude);
  const incoming = {
    id: `FAA_${group}_${name}`,
    name,
    position,
    latitude,
    longitude,
    source: "FAA",
    kind,
  };
  const existing = waypointMap.get(name);
  if (!existing || kind === "AIRPORT" || (kind === "VOR" && existing.kind === "FIX")) waypointMap.set(name, incoming);
}

const knownNames = new Set(waypointMap.keys());
const airwayProcedures = parseAirways(tables.get("AWY") ?? [], knownNames);
const terminalProcedures = [
  ...parseTerminal(tables.get("STAR") ?? [], knownNames, "STAR"),
  ...parseTerminal(tables.get("DP") ?? [], knownNames, "SID"),
];

const waypointCount = waypointMap.size;
const airwayCount = airwayProcedures.length;
const procedureCount = terminalProcedures.length;
const status = waypointCount >= 20 ? "READY" : "UNAVAILABLE";

if (status !== "READY") diagnostics.push(`Only ${waypointCount} usable DFW-region FAA waypoints were normalized; demo navigation remains the runtime fallback.`);
if (procedureCount === 0) diagnostics.push("No terminal procedure sequences were normalized from this NASR CSV revision; demo SID/STAR procedures remain available while the importer aliases are refined.");
diagnostics.push("FAA CIFP is recorded as the future ARINC 424 leg-fidelity source; this build uses openly structured NASR CSV data for runtime normalization.");

const dataset = {
  meta: {
    provider: "FAA NASR",
    cycle,
    effectiveDate: cycle,
    generatedAt: new Date().toISOString(),
    status,
    waypointCount,
    procedureCount,
    airwayCount,
    sourceUrls,
    diagnostics,
  },
  waypoints: [...waypointMap.values()],
  procedures: [...airwayProcedures, ...terminalProcedures],
};

await mkdir(new URL("../public/data/faa/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(dataset)}\n`, "utf8");

console.log(`[OpenRC FAA] Output: ${waypointCount} waypoints, ${airwayCount} airways, ${procedureCount} terminal procedures (${status}).`);
if (diagnostics.length) for (const item of diagnostics) console.log(`[OpenRC FAA] NOTE: ${item}`);

if (!BEST_EFFORT && status !== "READY") process.exitCode = 1;

function parseAirways(rows, known) {
  const grouped = new Map();
  for (const row of rows) {
    const values = Object.values(row).map((value) => String(value ?? "").trim().toUpperCase());
    const airway = normalizeIdentifier(
      pick(row, ["AWY_ID", "AIRWAY_ID", "AIRWAY_IDENTIFIER", "ROUTE_ID", "ROUTE_IDENTIFIER"])
      ?? values.find((value) => /^(?:V|J|Q|T)\d{1,4}[A-Z]?$/.test(value)),
    );
    if (!airway || !/^[A-Z][A-Z0-9-]{1,9}$/.test(airway)) continue;

    const explicitPoint = normalizeIdentifier(pick(row, [
      "FIX_ID", "FIX_IDENTIFIER", "POINT_ID", "POINT_IDENTIFIER", "NAV_ID", "NAVAID_ID", "WAYPOINT_ID",
    ]));
    const matches = explicitPoint && known.has(explicitPoint)
      ? [explicitPoint]
      : unique(values.filter((value) => known.has(value) && value !== airway));
    if (matches.length === 0) continue;

    const sequence = parseSequence(pick(row, ["POINT_SEQ", "POINT_SEQUENCE", "AWY_POINT_SEQ", "SEQUENCE_NUMBER", "SEQUENCE", "SEQ"]));
    const list = grouped.get(airway) ?? [];
    matches.forEach((point, matchIndex) => list.push({ point, sequence: sequence + matchIndex / 100 }));
    grouped.set(airway, list);
  }

  const procedures = [];
  for (const [airway, entries] of grouped) {
    const route = unique(entries.sort((a, b) => a.sequence - b.sequence).map((entry) => entry.point));
    if (route.length < 2) continue;
    procedures.push({
      id: `FAA_AWY_${airway}`,
      name: airway,
      type: "AIRWAY",
      source: "FAA",
      immutable: true,
      legs: route.slice(1).map((toFix, index) => ({
        id: `FAA_AWY_${airway}_${index + 1}`,
        fromFix: route[index],
        toFix,
        legType: "TRACK_TO_FIX",
      })),
    });
  }
  return procedures.slice(0, 500);
}

function parseTerminal(rows, known, type) {
  const grouped = new Map();
  for (const row of rows) {
    const procedure = procedureName(row, type);
    if (!procedure) continue;
    const values = Object.values(row).map((value) => String(value ?? "").trim().toUpperCase());
    const explicitPoint = normalizeIdentifier(pick(row, [
      "FIX_ID", "FIX_IDENTIFIER", "POINT_ID", "POINT_IDENTIFIER", "NAV_ID", "NAVAID_ID", "WAYPOINT_ID", "WAYPOINT_IDENTIFIER",
    ]));
    const matches = explicitPoint && known.has(explicitPoint)
      ? [explicitPoint]
      : unique(values.filter((value) => known.has(value) && value !== procedure && value !== "DFW" && value !== "KDFW"));
    if (matches.length === 0) continue;

    const sequence = parseSequence(pick(row, ["POINT_SEQ", "POINT_SEQUENCE", "SEQUENCE_NUMBER", "SEQUENCE", "SEQ", "ROUTE_SEQUENCE"]));
    const airport = normalizeIdentifier(pick(row, ["ARPT_ID", "AIRPORT_ID", "AIRPORT_IDENTIFIER", "LOC_ID", "AIRPORT"]));
    const list = grouped.get(procedure) ?? { entries: [], dfw: false };
    matches.forEach((point, matchIndex) => list.entries.push({ point, sequence: sequence + matchIndex / 100 }));
    if (airport === "DFW" || airport === "KDFW" || values.includes("DFW") || values.includes("KDFW")) list.dfw = true;
    grouped.set(procedure, list);
  }

  const result = [];
  for (const [name, group] of grouped) {
    const route = unique(group.entries.sort((a, b) => a.sequence - b.sequence).map((entry) => entry.point));
    if (route.length < 2) continue;
    result.push({
      id: `FAA_${type}_${name}`,
      name,
      type,
      source: "FAA",
      immutable: true,
      legs: route.slice(1).map((toFix, index) => ({
        id: `FAA_${type}_${name}_${index + 1}`,
        fromFix: route[index],
        toFix,
        legType: "TRACK_TO_FIX",
      })),
    });
  }
  return result.slice(0, 350);
}

function procedureName(row, type) {
  const preferred = type === "STAR"
    ? ["STAR_NAME", "STAR_ID", "PROCEDURE_NAME", "PROCEDURE_ID", "ROUTE_NAME"]
    : ["DP_NAME", "DP_ID", "DEPARTURE_PROCEDURE_NAME", "PROCEDURE_NAME", "PROCEDURE_ID", "ROUTE_NAME"];
  const direct = normalizeIdentifier(pick(row, preferred));
  if (direct && /^[A-Z][A-Z0-9.-]{2,12}$/.test(direct)) return direct;

  for (const [key, raw] of Object.entries(row)) {
    const header = canonical(key);
    if (type === "STAR" && !header.includes("STAR") && !header.includes("PROCEDURE")) continue;
    if (type === "SID" && !header.includes("DP") && !header.includes("DEPARTURE") && !header.includes("PROCEDURE")) continue;
    const value = normalizeIdentifier(raw);
    if (value && /^[A-Z][A-Z0-9.-]{2,12}$/.test(value)) return value;
  }
  return "";
}

function pick(row, aliases) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const target = canonical(alias);
    const exact = entries.find(([key]) => canonical(key) === target);
    if (exact && String(exact[1] ?? "").trim()) return exact[1];
  }
  for (const alias of aliases) {
    const target = canonical(alias);
    const partial = entries.find(([key]) => canonical(key).includes(target));
    if (partial && String(partial[1] ?? "").trim()) return partial[1];
  }
  return undefined;
}

function findCoordinate(row, axis) {
  const candidates = Object.entries(row)
    .filter(([key, value]) => {
      const header = canonical(key);
      if (!String(value ?? "").trim()) return false;
      if (axis === "LAT") return header.includes("LAT") && !header.includes("STATE");
      return (header.includes("LON") || header.includes("LONG")) && !header.includes("LENGTH");
    })
    .sort(([a], [b]) => coordinateHeaderScore(b, axis) - coordinateHeaderScore(a, axis));

  for (const [, value] of candidates) {
    const parsed = parseCoordinate(value, axis);
    if (parsed !== null) return parsed;
  }
  return null;
}

function coordinateHeaderScore(header, axis) {
  const value = canonical(header);
  let score = value.includes(axis === "LAT" ? "LATITUDE" : "LONGITUDE") ? 5 : 1;
  if (value.includes("DECIMAL") || value.includes("DEC")) score += 5;
  if (value.includes("SECONDS") || value.endsWith("SEC")) score -= 3;
  return score;
}

function parseCoordinate(raw, axis) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toUpperCase();
  if (!text) return null;
  const direction = text.match(/[NSEW]/)?.[0];
  const sign = direction === "S" || direction === "W" ? -1 : 1;
  const plain = text.replace(/[NSEW]/g, "").trim();
  const direct = Number(plain);
  if (Number.isFinite(direct)) {
    const value = direction ? Math.abs(direct) * sign : direct;
    if (validCoordinate(value, axis)) return value;
  }

  const pieces = plain.split(/[^0-9.]+/).filter(Boolean).map(Number);
  if (pieces.length >= 2 && pieces.every(Number.isFinite)) {
    const value = (Math.abs(pieces[0]) + (pieces[1] ?? 0) / 60 + (pieces[2] ?? 0) / 3600) * sign;
    if (validCoordinate(value, axis)) return value;
  }

  const compact = plain.replace(/[^0-9.]/g, "");
  const degreeDigits = axis === "LAT" ? 2 : 3;
  if (compact.length >= degreeDigits + 4) {
    const degrees = Number(compact.slice(0, degreeDigits));
    const minutes = Number(compact.slice(degreeDigits, degreeDigits + 2));
    const seconds = Number(compact.slice(degreeDigits + 2));
    const value = (degrees + minutes / 60 + seconds / 3600) * sign;
    if (validCoordinate(value, axis)) return value;
  }
  return null;
}

function validCoordinate(value, axis) {
  return Number.isFinite(value) && (axis === "LAT" ? Math.abs(value) <= 90 : Math.abs(value) <= 180);
}

function parseSequence(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 999999;
}

function normalizeIdentifier(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return text.replace(/\s+/g, "").replace(/[^A-Z0-9.-]/g, "");
}

function canonical(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function latLonToLocal(latitude, longitude) {
  return {
    x: (longitude - DFW.longitude) * 60 * Math.cos((DFW.latitude * Math.PI) / 180),
    y: (latitude - DFW.latitude) * 60,
  };
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const radiusNm = 3440.065;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radiusNm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function currentNasrCycle(now) {
  const anchor = Date.UTC(2026, 7, 6);
  const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cycles = Math.max(0, Math.floor((current - anchor) / (28 * 24 * 60 * 60 * 1000)));
  return new Date(anchor + cycles * 28 * 24 * 60 * 60 * 1000);
}

function monthAbbr(month) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month];
}
