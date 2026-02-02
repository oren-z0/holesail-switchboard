# Umbrel Instructions

With Holesail-Switchboard installed, you can let remote users access your apps, by adding their docker containers as servers.

BE CAREFUL: DO NOT OPEN UNINTENDED PORTS TO THE PUBLIC!

To list the hostnames of all the installed apps, go to... and run:

```bash
sudo docker network inspect umbrel_main_network --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' | sort
```

For example, `mempool_web_1` is the hostname of the Mempool Web app.

If you want to expose the app interface (i.e. what you see when you click the app icon in the Umbrel dashboard),
which is usually the container with the suffix `_web_1`, you can find the port number by running:

```bash
cat ~/umbrel/app-data/<app-name>/umbrel-app.yml | yq '.port'
```

For example:

```bash
cat ~/umbrel/app-data/mempool/umbrel-app.yml | yq '.port'
```

If you want to expose an internal container, you will have to dig in the docker-compose.yml and exports.sh files inside `~/umbrel/app-data/<app-name>`.

## List of common container names and their ports

- mempool_web_1: 3006
- lnbits_web_1: 3007
- btcpay-server_web_1: 3003
- bitcoin_app_1: 8332 (RPC) 8333 (P2P)
- holesail-switchboard_web_1: 3160 (Yo dawg, you can let remote users access this app too!)
