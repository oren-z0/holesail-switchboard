# Holesail Switchboard

A web interface to manage multiple [holesail](https://github.com/holesail/holesail) servers and clients for peer-to-peer connections.

## Features

- Create and manage multiple holesail servers
- Create and manage multiple holesail clients
- Real-time status monitoring (running, failed, disabled, initializing)
- QR code generation for server connection URLs
- Secure mode support for servers
- Persistent configuration storage

## Setup

1. Copy `.env.example` to `.env` and configure the variables
2. Run `npm install` to install dependencies
3. Run `npm run dev` for development or `npm run build && npm run start` for production

See [.env.example](.env.example) for available environment variables.
