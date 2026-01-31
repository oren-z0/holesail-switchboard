# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Holesail Server Manager is a web interface to manage a [holesail-server](https://github.com/holesail/holesail-server) instance with a predefined target server. It provides seed management, public key display with QR codes, and connection management.

## Commands

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

**Backend**: Single Fastify server (`src/server.js`) with REST API endpoints:
- `GET /api/settings` - Returns current seed and public key
- `POST /api/settings` - Updates seed and restarts holesail-server

**Frontend**: Alpine.js SPA (`src/static/index.html`) with Tailwind CSS styling

**Data persistence**: JSON file (`data/hsm.json`) storing the seed

**Integration**: Uses `holesail-server` npm package for peer-to-peer connections

## Environment Variables

Copy `.env.example` to `.env`. Key variables:
- `HSM_DATA_FILE` - Path to seed storage file
- `HSM_PORT` / `HSM_HOST` - Web server binding
- `HSM_TARGET_PORT` / `HSM_TARGET_ADDRESS` - Target server for holesail tunneling

## Code Style

ESLint enforces:
- Semicolons required
- Max line length: 120 characters
- Trailing commas only in multiline
- Prefix unused parameters with `_`
- Only `console.info`, `console.warn`, `console.error` allowed (no `console.log`)

## Key Constraints

- Seeds must be exactly 64 hexadecimal characters
- No test suite currently exists
- JS files use CommonJS (`sourceType: 'script'`)
- HTML files use ES modules
