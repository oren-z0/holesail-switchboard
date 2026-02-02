# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Holesail Switchboard is a web interface to manage multiple [holesail](https://github.com/holesail/holesail) servers and clients. It provides a centralized dashboard for creating, editing, and monitoring peer-to-peer connections.

## CLI Usage

Run directly with npx (no installation required):

```bash
npx holesail-switchboard                    # Start with defaults, opens browser
npx holesail-switchboard --port 4000        # Custom port
npx holesail-switchboard --no-open          # Don't open browser
npx holesail-switchboard --data-file /path  # Custom data file location
```

CLI flags: `-d, --data-file`, `-p, --port`, `-H, --host`, `-c, --client-host`, `--no-open`, `-h, --help`

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start development server (watches server, CSS, and static files)
npm run build        # Production build
npm run start        # Run production server
npm run lint         # Run ESLint
npm run lint:fix     # Fix ESLint issues
npm run docker:build-to-registry  # Build multi-platform Docker image
```

## Architecture

**Backend**: Single Fastify server (`src/server.js`) with CLI (using `commander`) and REST API endpoints:
- `GET /api/settings` - Returns all servers and clients with their runtime state
- `POST /api/servers` - Create a new holesail server
- `PATCH /api/servers/:index` - Update a server (restarts it with new config)
- `DELETE /api/servers/:index` - Delete a server
- `POST /api/clients` - Create a new holesail client
- `PATCH /api/clients/:index` - Update a client
- `DELETE /api/clients/:index` - Delete a client

**Frontend**: Alpine.js SPA (`src/static/index.html`) with Tailwind CSS styling

**Data persistence**: JSON file (`data/hssb.json`) storing server and client configurations

**Data model**:
```json
{
  "holesailServers": [
    { "host": "0.0.0.0", "port": 8080, "key": "64hexchars", "secure": false, "enabled": true }
  ],
  "holesailClients": [
    { "key": "z32key", "port": 9000, "enabled": true }
  ]
}
```

**Runtime states**: "initializing" → "running" | "failed" | "disabled"

**Integration**: Uses `holesail` npm package directly for both server and client connections

## Environment Variables

CLI flags take precedence over environment variables. Copy `.env.example` to `.env`. Key variables:
- `HSSB_DATA_FILE` - Path to JSON state file (defaults to OS-specific location if not set)
- `HSSB_PORT` / `HSSB_HOST` - Web dashboard UI binding
- `HSSB_CLIENT_HOST` - Host for holesail clients to bind to (defaults to 127.0.0.1)
- `HSSB_CLIENT_LINK_DOMAIN` - Domain for client links in dashboard (blank=same as dashboard, `<nolink>`=disable)
- `HSSB_SUBTITLE` - Optional subtitle for the UI
- `HSSB_FIXED_CLIENT_PORTS` - Comma-separated list of fixed client ports

**Default data file locations** (when not specified):
- macOS: `~/Library/Application Support/holesail-switchboard/data.json`
- Linux: `~/.config/holesail-switchboard/data.json`
- Windows: `%APPDATA%/holesail-switchboard/data.json`

## Code Style

ESLint enforces:
- Semicolons required
- Max line length: 120 characters
- Trailing commas only in multiline
- Prefix unused parameters with `_`
- Only `console.info`, `console.warn`, `console.error` allowed (no `console.log`)

## Key Constraints

- Server keys must be exactly 64 hexadecimal characters
- Client keys are z32 encoded strings from the server's public key
- No test suite currently exists
- JS files use CommonJS (`sourceType: 'script'`)
- HTML files use ES modules
