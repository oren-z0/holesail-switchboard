# Umbrel Instructions

With Holesail-Switchboard installed, you can let remote users access your apps, by adding their docker containers as servers.

BE CAREFUL: DO NOT OPEN UNINTENDED PORTS TO THE PUBLIC!

To list the hostnames of all the installed apps, go to Settings > Advanced settings > Terminal > umbrelOS and run:

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

After adding the container hostname & port as a server in the Holesail Switchboard UI, you will get a holesail URL (something like 'hs://0...'),
which you can use on a different Umbrel machine as a client.

You can also access it from any computer with Node.JS, by calling:
```bash
npx holesail --connect <hs-url> --host localhost --port 8080
```

And also from [Android](https://play.google.com/store/apps/details?id=io.holesail.holesail.go) or [iOS](https://apps.apple.com/us/app/holesail-go/id6503728841) devices.

Disclosure: I'm not part of the Holesail core team. I only (vibe) coded this UI and dockerized it.
If you have questions about the technology, check out https://holesail.io and https://npmjs.com/package/holesail

## Opening a Lightning channel over a Holesail connection

Holesail-Switchboard lets you open P2P Lightning channels on Umbrel without a public IP address and without relying on unreliable Tor.

Steps:
1. On both Umbrel nodes, install: one of Bitcoin node apps (tested with Core), one of the Lightning apps (tested with LND) and the Holesail-Switchboard app.
2. On the channel-destination node, open Holesail-Switchboard and click *Add Server* with Host: "lightning_lnd_1" and Port: "9735". Do not enable the *Secure* checkbox (This option is designed for hiding both ends of the connection using a symmetric key. In this case, you want a public key so others can reach your node). This will generate an "hs://0000..." connection URL that others can use to connect to you.
3. On the same node, open the Lightning app, click the 3 dots in the top-right corner, and select *Node ID*. Under the Tor network section, you will see: `<lightning-public-key>@<address>.onion:9735`. We do not need the `<address>.onion` part, but we do need the `<lightning-public-key>` part, which identifies your Lightning node.
4. On the channel-source node, open Holesail-Switchboard and click the ✏️ icon on one of the clients. Paste the "hs://..." connection URL and note the assigned local port (for example: "3161").
5. Finally, in the Lightning app, open a channel using: `<lightning-public-key>@10.21.0.20:<local-port>`. Example: `03abc123...@10.21.0.20:3161` (the `10.21.0.20` ip belongs to the Holesail-Switchboard app - I've tried different local hostnames but it didn't work for me).

That's it! You now have a lightning channel that uses [Holepunch](https://holepunch.to) technology, doesn't rely on a static public ip address, and much more stable than TOR.

## List of common container names and their ports

- mempool_web_1: 3006
- lnbits_web_1: 3007
- btcpay-server_web_1: 3003
- bitcoin_app_1: 8332 (RPC) 8333 (P2P)
- lightning_lnd_1: 9735
- specter-desktop_web_1: 25441
- holesail-switchboard_web_1: 3160 (Yo dawg, you can let remote users access this app too!)
