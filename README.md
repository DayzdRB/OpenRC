# OpenRC — Open Radar Control

OpenRC is a browser-based air traffic control simulator built around one product rule: **realism should come from controller decisions and simulation behavior, not from making the interface unnecessarily difficult.**

The project is designed so a player can staff one controller position while deterministic simulator controllers operate the rest of the ATC system. Aircraft continue flying, following procedures, receiving clearances, and handing off between positions rather than spawning only inside the player's scope.

## Current vertical slice

The first branch implements a DFW-area demo world with:

- switchable human D10 TRACON and ZFW Center positions while adjacent positions remain AI staffed
- deterministic seeded simulation state
- aircraft inertia: turn rate, acceleration/deceleration, climb/descent rates
- arrivals, departures, and an overflight that remain part of the simulated world
- explicit requested/accepted/completed handoffs shared by AI and human positions
- route following plus structured SID/STAR demo legs and restrictions
- compact strips with heading degrees, normal altitude below 18,000 ft, flight levels above it, knots, and controller-relevant destination/exit fix
- predicted terminal/center separation alerts
- basic runway wake restriction countdown state
- Off/Subtle/Safety/Full semi-topographic terrain presentation
- right-click → Create Waypoint with deterministic unique five-letter names
- left-click custom waypoint editing with rename/delete and dependency checks
- a basic Procedure Lab that preserves immutable official-demo procedures and duplicates them into editable custom overlays
- local browser scenario save/load
- controller event log suitable as the beginning of deterministic replay/debrief support

## Architecture

The simulator is intentionally separated from React:

```text
app/ + components/
      ↓ snapshots / controller commands
packages/simulation/
      ├── aircraft physics
      ├── navigation / procedures
      ├── controller staffing
      ├── handoffs
      ├── separation
      └── deterministic scenario state
```

`packages/simulation` has no React dependency. Multiplayer can later replace a local human controller adapter with a remote controller adapter without replacing aircraft physics or AI controller logic.

## Run locally

```bash
npm install
npm run dev
```

Then open the local Next.js URL shown in the terminal.

## Deploy

The app is compatible with a standard Vercel Next.js project using the repository root as the project root. It intentionally requires no database, paid mapping service, paid AI API, paid aviation data, or paid voice service for this slice.

## Navigation-data warning

The current DFW dataset is a **demo dataset for simulation development and is not authoritative FAA navigation data**. It mixes approximate real-world reference locations with scenario points and simplified procedures. Do not use it for real-world navigation.

The planned importer boundary is:

```text
FAA NASR / CIFP / other supported public data
                    ↓
                 importer
                    ↓
        normalized OpenRC nav database
                    ↓
            simulation engine
```

Official imported data will be immutable; custom and scenario data will live in overlays.

## Working name

The repository keeps the user's `OpenRC` name and currently expands it as **Open Radar Control**. Branding is kept out of the simulation package so a later rename does not alter simulation architecture.
