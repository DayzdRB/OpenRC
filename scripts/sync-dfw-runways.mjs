import { readFile, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";

const DFW = { latitude: 32.8998, longitude: -97.0403 };
const BEST_EFFORT = process.argv.includes("--best-effort");
const outputPath = new URL("../public/data/faa/dfw.json", import.meta.url);

try {
  const dataset = JSON.parse(await readFile(outputPath, "utf8"));
  const effective = new Date(`${dataset.meta?.cycle ?? "2026-08-06"}T00:00:00Z`);
  const dateSlug = `${String(effective.getUTCDate()).padStart(2, "0")}_${monthAbbr(effective.getUTCMonth())}_${effective.getUTCFullYear()}`;
  const url = `https://nfdc.faa.gov/webContent/28DaySub/extra/${dateSlug}_APT_CSV.zip`;

  const response = await fetch(url, {
    headers: { "user-agent": "OpenRC/0.3 FAA DFW runway importer" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`APT HTTP ${response.status}`);

  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const rows = [];
  for (const [name, bytes] of Object.entries(zip)) {
    if (!name.toLowerCase().endsWith(".csv")) continue;
    const text = new TextDecoder("utf-8").decode(bytes);
    try {
      rows.push(...parse(text, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
      }));
    } catch {
      // APT includes schema/support CSV files; a bad auxiliary file should not block runway geometry.
    }
  }

  const grouped = new Map();
  for (const row of rows) {
    const airport = String(row.ARPT_ID ?? "").trim().toUpperCase();
    if (airport !== "DFW" && airport !== "KDFW") continue;
    const runwayId = String(row.RWY_ID ?? "").trim().toUpperCase();
    const endId = String(row.RWY_END_ID ?? "").trim().toUpperCase();
    const latitude = Number(row.LAT_DECIMAL);
    const longitude = Number(row.LONG_DECIMAL);
    if (!runwayId || !endId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (Math.abs(latitude - DFW.latitude) > 0.2 || Math.abs(longitude - DFW.longitude) > 0.25) continue;

    const byEnd = grouped.get(runwayId) ?? new Map();
    byEnd.set(endId, {
      id: endId,
      latitude,
      longitude,
      position: latLonToLocal(latitude, longitude),
    });
    grouped.set(runwayId, byEnd);
  }

  const runways = [];
  for (const [runwayId, ends] of grouped) {
    const values = [...ends.values()];
    if (values.length < 2) continue;
    const [firstName, secondName] = runwayId.split("/");
    const first = values.find((end) => end.id === firstName) ?? values[0];
    const second = values.find((end) => end.id === secondName) ?? values.find((end) => end.id !== first.id) ?? values[1];
    if (!first || !second || first.id === second.id) continue;
    runways.push({
      id: `FAA_DFW_RWY_${runwayId.replace(/[^A-Z0-9]/g, "_")}`,
      runwayId,
      ends: [first, second],
      source: "FAA NASR APT",
    });
  }

  runways.sort((a, b) => a.runwayId.localeCompare(b.runwayId, undefined, { numeric: true }));
  dataset.runways = runways;
  dataset.meta = dataset.meta ?? {};
  dataset.meta.diagnostics = Array.isArray(dataset.meta.diagnostics) ? dataset.meta.diagnostics : [];
  dataset.meta.diagnostics.push(`DFW runway geometry: ${runways.length} runway segments normalized from FAA NASR APT runway-end coordinates.`);
  await writeFile(outputPath, `${JSON.stringify(dataset)}\n`, "utf8");
  console.log(`[OpenRC FAA] DFW runway geometry: ${runways.length} runways (${runways.map((runway) => runway.runwayId).join(", ") || "none"}).`);

  if (runways.length < 7 && !BEST_EFFORT) process.exitCode = 1;
} catch (error) {
  console.warn(`[OpenRC FAA] DFW runway geometry unavailable: ${error instanceof Error ? error.message : String(error)}`);
  if (!BEST_EFFORT) process.exitCode = 1;
}

function latLonToLocal(latitude, longitude) {
  return {
    x: (longitude - DFW.longitude) * 60 * Math.cos((DFW.latitude * Math.PI) / 180),
    y: (latitude - DFW.latitude) * 60,
  };
}

function monthAbbr(month) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month];
}
