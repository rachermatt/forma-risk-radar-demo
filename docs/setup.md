# Forma Risk Radar Demo — Setup

## Requirements

Node.js 22 or newer, npm, and Git. No Autodesk account, APS app, credentials, Docker,
PostgreSQL server, database seed, or environment file is required.

## Run locally

```bash
git clone https://github.com/rachermatt/forma-risk-radar-demo.git
cd forma-risk-radar-demo
npm ci
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

The dashboard always reads deterministic fictional data from `src/lib/demo/generator.ts`.
`DATA_MODE` is ignored by the demo page. Autodesk login, callback, and logout handlers are
preserved only as library reference code and are not exposed as HTTP routes.

## Production build

```bash
npm run build
npm start
```

This is a Next.js server app, not a static GitHub Pages export. Deploy with a hosting service
that supports a Node.js/Next.js server. Set the optional `APP_ORIGIN` to your deployed HTTPS
origin for social metadata. Do not add Autodesk credentials or database settings.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

`GET /api/health` returns liveness status. `GET /api/readiness` reports `mode: "demo"`,
`database: "not-required"`, and `liveData: "synthetic-demo"`. Requests to `/api/aps/…`
return 404 without redirects or authentication cookies, even with `DATA_MODE=autodesk`.

## Troubleshooting

If port 8080 is already occupied, run the server on another port:

```bash
npm run dev -- --port 8082
```

Open `http://localhost:8082` in that case. Demo interactions update URL state, but they do
not modify a real Autodesk hub. Reloading restores the same deterministic scenario.

Backend provider, database, seed, and authentication library tests remain available for
reference. They are not setup steps or active services in this demo.
