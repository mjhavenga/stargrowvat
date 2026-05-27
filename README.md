# Stargrow VAT

Internal VAT and ICP reporting app for Stargrow Europe. The app connects to Xero, pulls accounting data for a selected VAT period, and rebuilds the VAT/ICP summaries that are currently prepared in the Excel template.

## Current scope

- Xero OAuth 2.0 connection
- Xero tenant/organisation selection
- Period-based invoice and credit note pulls
- VAT box mapping via `config/vat-mapping.json`
- ICP customer grouping and exception checks
- Single Node web service that serves both the UI and API

## Environment variables

Create a Xero OAuth app and set:

```bash
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=replace-with-a-long-random-string
APP_USER_NAME=mjhavenga
APP_USER_PASSWORD=...
DATA_DIR=./data
```

For Render, set `XERO_REDIRECT_URI` to:

```bash
https://YOUR-RENDER-SERVICE.onrender.com/auth/callback
```

Add the same callback URL in the Xero developer app settings.

For Render, use a persistent disk and set `DATA_DIR=/var/data` so Xero tokens, login sessions, and saved return history are not lost on deploy/restart.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Notes

The first implementation reconstructs the template from Xero source transactions rather than relying on manual Excel exports. Review `config/vat-mapping.json` after connecting the first real Xero organisation, because Xero tax rate names can differ between tenants.
