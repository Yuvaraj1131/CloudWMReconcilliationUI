# Deployment & Backend Wiring

This app is a **standalone SAPUI5** application that runs on the **SAP Build Work Zone /
Fiori launchpad**, served by the **managed approuter** out of the **HTML5 Application
Repository**, and talks to your already-deployed **CAP** app through a **destination**.

## Your environment

| | |
|---|---|
| CF org | `bsx-sysco-sandbox-f20` |
| CF space | `sandbox-f20` |
| CF API endpoint | `https://api.cf.eu10-004.hana.ondemand.com` |
| CAP app | `CloudWMReconciliation-srv` |
| CAP base URL | `https://bsx-sysco-sandbox-f20-sandbox-f20-cloudwmreconciliation-srv.cfapps.eu10-004.hana.ondemand.com` |
| Destination name | `CloudWMReconcilliation` |

## How the backend is reached

- **BAS preview** — the `fiori-tools-proxy` in [`ui5.yaml`](ui5.yaml) forwards
  `/ReconcileService/*` to the `CloudWMReconcilliation` destination (same-origin, no CORS).
- **Deployed** — the managed approuter applies the routes in [`xs-app.json`](xs-app.json),
  forwarding `/ReconcileService/*` to the same `CloudWMReconcilliation` destination.

The app calls **relative** URLs (`/ReconcileService/getECCDeliveryItems(...)`), so the same
code works in both contexts.

---

## Step 1 — Create the `CloudWMReconcilliation` destination

BTP cockpit → subaccount → **Connectivity → Destinations → New Destination**:

| Field | Value |
|---|---|
| Name | `CloudWMReconcilliation` |
| Type | `HTTP` |
| URL | `https://bsx-sysco-sandbox-f20-sandbox-f20-cloudwmreconciliation-srv.cfapps.eu10-004.hana.ondemand.com` |
| Proxy Type | `Internet` |
| Authentication | `NoAuthentication` |

Add these **Additional Properties**:

| Property | Value | Why |
|---|---|---|
| `HTML5.ForwardAuthToken` | `true` | forwards the logged-in user's JWT to CAP |
| `HTML5.DynamicDestination` | `true` | lets the app target the destination at runtime |
| `WebIDEEnabled` | `true` | makes it visible to BAS for preview |

> If CAP rejects the forwarded token, the CAP app must trust the same XSUAA instance as this
> app (the managed approuter uses the subaccount XSUAA). For same-subaccount apps this is the
> default.

## Step 2 — Verify the service base path

`CONFIG` is already wired to the real **`ReconcileService`** (OData V4):

| Service | Kind | Invocation |
|---|---|---|
| ECC fetch | function | `GET getECCDeliveryItems(CreatedOn=<DateTimeOffset>)` |
| HANA fetch | function | `GET getHanaDeliveryItems(DeliveryDate=<Date>)` |
| HANA write | action | `POST updateHanaDeliveryItems` body `{ "items": [ … ] }` |

The reconciliation key is `Delivery_Delivery` + `Item`, and the tables bind the
`DeliveryItems` properties (`Material_Material`, `DeliveryQuantity`, `SalesUnit_UnitCode`,
`Plant`, `StorageLocation`).

The only thing to confirm is **`SERVICE_BASE`** in
[`webapp/controller/Main.controller.js`](webapp/controller/Main.controller.js): it must match
the path where you found `$metadata`. It is `/ReconcileService` — confirmed against your
working URL, so no change is needed.

## Step 3 — Preview in BAS

```bash
npm install
npm start          # or: BAS → right-click project → Preview Application → "start"
```

Pick a date → ECC + HANA load in parallel → open **Missing Items** → select rows →
**Post Selected to HANA** → rows turn green.

## Step 4 — Add deployment configuration

Let the Fiori tools generate the (managed-approuter) `mta.yaml` — do **not** hand-write it:

> Command Palette (⇧⌘P) → **Fiori: Add Deployment Configuration** → **Cloud Foundry** →
> **managed approuter** → select destination **`CloudWMReconcilliation`**.

This creates `mta.yaml`, wires `xs-app.json`, and adds build scripts.

## Step 5 — Build & deploy

```bash
npm install -g mbt                 # one-time
cf install-plugin multiapps        # one-time (enables "cf deploy")
cf login -a https://api.cf.eu10-004.hana.ondemand.com   # org bsx-sysco-sandbox-f20 / space sandbox-f20
mbt build                          # -> mta_archives/<app>.mtar
cf deploy mta_archives/*.mtar
```

## Step 6 — Surface it on the launchpad

**SAP Build Work Zone** → your site → add the app to a group/role → assign your user.
The `crossNavigation` inbound in [`webapp/manifest.json`](webapp/manifest.json)
(semantic object `LIPSReconciliation`, action `display`) is what the launchpad uses to
create the tile.
