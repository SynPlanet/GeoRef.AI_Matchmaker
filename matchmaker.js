// Copyright Epic Games, Inc. All Rights Reserved.
var enableRedirectionLinks = true;
var enableRESTAPI = true;

const defaultConfig = {
  // The port clients connect to the matchmaking service over HTTP
  HttpPort: 80,
  UseHTTPS: false,
  // The matchmaking port the signaling service connects to the matchmaker
  MatchmakerPort: 9999,

  // Log to file
  LogToFile: true,
};

// Similar to the Signaling Server (SS) code, load in a config.json file for the MM parameters
const argv = require("yargs").argv;

var bodyParser = require("body-parser");

var configFile =
  typeof argv.configFile != "undefined"
    ? argv.configFile.toString()
    : "config.json";
const config = require("./modules/config.js").init(configFile, defaultConfig);
console.log("Config: " + JSON.stringify(config, null, "\t"));

const express = require("express");
var cors = require("cors");
const app = express();

const http = require("http").Server(app);
const fs = require("fs");
const path = require("path");
const logging = require("./modules/logging.js");
logging.RegisterConsoleLogger();

app.use(bodyParser.json());
app.use(cors());

if (config.LogToFile) {
  logging.RegisterFileLogger("./logs");
}

// A list of all the Cirrus server which are connected to the Matchmaker.
var cirrusServers = new Map();
let connectionIndex = 0;
//
// Parse command line.
//

if (typeof argv.HttpPort != "undefined") {
  config.HttpPort = argv.HttpPort;
}
if (typeof argv.MatchmakerPort != "undefined") {
  config.MatchmakerPort = argv.MatchmakerPort;
}

http.listen(config.HttpPort, () => {
  console.log("HTTP listening on *:" + config.HttpPort);
});

if (config.UseHTTPS) {
  //HTTPS certificate details
  const options = {
    key: fs.readFileSync(path.join(__dirname, "./certificates/client-key.pem")),
    cert: fs.readFileSync(
      path.join(__dirname, "./certificates/client-cert.pem")
    ),
  };

  var https = require("https").Server(options, app);

  //Setup http -> https redirect
  console.log("Redirecting http->https");
  app.use(function (req, res, next) {
    if (!req.secure) {
      if (req.get("Host")) {
        var hostAddressParts = req.get("Host").split(":");
        var hostAddress = hostAddressParts[0];
        if (httpsPort != 443) {
          hostAddress = `${hostAddress}:${httpsPort}`;
        }
        return res.redirect(
          ["https://", hostAddress, req.originalUrl].join("")
        );
      } else {
        console.error(
          `unable to get host name from header. Requestor ${
            req.ip
          }, url path: '${req.originalUrl}', available headers ${JSON.stringify(
            req.headers
          )}`
        );
        return res.status(400).send("Bad Request");
      }
    }
    next();
  });

  https.listen(443, function () {
    console.log("Https listening on 443");
  });
}

// No servers are available so send some simple JavaScript to the client to make
// it retry after a short period of time.
function sendRetryResponse(res) {
  res.send(`All ${cirrusServers.size} Cirrus servers are in use. Retrying in <span id="countdown">3</span> seconds.
	<script>
		var countdown = document.getElementById("countdown").textContent;
		setInterval(function() {
			countdown--;
			if (countdown == 0) {
				window.location.reload(1);
			} else {
				document.getElementById("countdown").textContent = countdown;
			}
		}, 1000);
	</script>`);
}

// Get a Cirrus server if there is one available which has no clients connected.
function getAvailableCirrusServer() {
  cirrusServers = new Map(
    [...cirrusServers.entries()].sort((a, b) => {
      if (a[1].index < b[1].index) return -1;
      if (a[1].index > b[1].index) return 1;
      return 0;
    })
  );

  for (cirrusServer of cirrusServers.values()) {
    if (!cirrusServer.clientConnected && cirrusServer.ready === true) {
      // Check if we had at least 10 seconds since the last redirect, avoiding the
      // chance of redirecting 2+ users to the same SS before they click Play.
      // In other words, give the user 10 seconds to click play button the claim the server.
      if (cirrusServer.hasOwnProperty("lastRedirect")) {
        if ((Date.now() - cirrusServer.lastRedirect) / 1000 < 10) continue;
      }
      cirrusServer.lastRedirect = Date.now();

      return cirrusServer;
    }
  }

  console.log("WARNING: No empty Cirrus servers are available");
  return undefined;
}

if (enableRESTAPI) {
  // Handle REST signalling server only request.
  app.get("/signallingserver", (req, res) => {
    cirrusServer = getAvailableCirrusServer();

    if (cirrusServer !== undefined) {
      res.json({
        signallingServer: `${cirrusServer.address}`,
      });
      console.log(`Returning ${cirrusServer.address}`);
    } else {
      res.json({
        signallingServer: "",
        error: "No signalling servers available",
      });
    }
  });

  app.get("/list", (req, res) => {
    res.json(
      Array.from(cirrusServers.values()).sort((a, b) => a.index - b.index)
    );
  });

  app.post("/check", (req, res) => {
    const currentServer = Array.from(cirrusServers.values()).find((server) => {
      return (
        server.address === req.body.address &&
        server.ready === true &&
        server.clientConnected === false
      );
    });

    const firstAvailableServer = getAvailableCirrusServer();

    res.json({
      available: !!currentServer,
      signallingServer:
        !currentServer && firstAvailableServer
          ? `${firstAvailableServer?.address}`
          : "",
    });
  });

  app.get("/debug-map", (req, res) => {
    res.json(
      Array.from(cirrusServers.entries())
    );
  });
}

if (enableRedirectionLinks) {
  // Handle standard URL.
  app.get("/", (req, res) => {
    cirrusServer = getAvailableCirrusServer();
    if (cirrusServer != undefined) {
      res.redirect(`http://${cirrusServer.address}/`);
      //console.log(req);
      console.log(`Redirect to ${cirrusServer.address}`);
    } else {
      sendRetryResponse(res);
    }
  });

  // Handle URL with custom HTML.
  app.get("/custom_html/:htmlFilename", (req, res) => {
    cirrusServer = getAvailableCirrusServer();
    if (cirrusServer != undefined) {
      res.redirect(
        `http://${cirrusServer.address}/custom_html/${req.params.htmlFilename}`
      );
      console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
    } else {
      sendRetryResponse(res);
    }
  });
}

//
// Connection to Cirrus.
//

const net = require("net");

function disconnect(connection) {
  console.log(
    `Ending connection to remote address ${connection.remoteAddress}`
  );
  connection.end();
}

const matchmaker = net.createServer((connection) => {
  connection.on("data", (data) => {
    try {
      message = JSON.parse(data);

      if (message) console.log(`Message TYPE: ${message.type}`);
    } catch (e) {
      console.log(
        `ERROR (${e.toString()}): Failed to parse Cirrus information from data: ${data.toString()}`
      );
      disconnect(connection);
      return;
    }
    if (message.type === "connect") {
      connection.address = message.address;
      // A Cirrus server connects to this Matchmaker server.
      cirrusServer = {
        address: message.address,
        clientConnected: false,
        lastPingReceived: Date.now(),
        index: connectionIndex++,
      };
      cirrusServer.ready = message.ready === true;

      // Handles disconnects between MM and SS to not add dupes with clientConnected = 0 and redirect users to same SS
      // Check if player is connected and doing a reconnect. message.playerConnected is a new variable sent from the SS to
      // help track whether or not a player is already connected when a 'connect' message is sent (i.e., reconnect).
      if (message.playerConnected == true) {
        cirrusServer.clientConnected = true;
      }

      // Find if we already have a ciruss server address connected to (possibly a reconnect happening)
      let server = [...cirrusServers.entries()].find(
        ([key, val]) =>
          val.address === cirrusServer.address
      );

      // if a duplicate server with the same address isn't found -- add it to the map as an available server to send users to.
      if (!server || server.size <= 0) {
        console.log(
          `Adding connection for ${
            cirrusServer.address.split(".")[0]
          } with playerConnected: ${message.playerConnected}`
        );
        cirrusServers.set(connection.address, cirrusServer);
      } else {
        console.log(
          `RECONNECT: cirrus server address ${
            cirrusServer.address.split(".")[0]
          } already found--replacing. playerConnected: ${
            message.playerConnected
          }`
        );
        var foundServer = cirrusServers.get(`${server.address}`);

        // Make sure to retain the clientConnected from the last one before the reconnect to MM
        if (foundServer) {
          cirrusServers.set(connection.address, cirrusServer);
          console.log(
            `Replacing server with original with clientConnected: ${cirrusServer.clientConnected}`
          );
          cirrusServers.delete(server[0]);
        } else {
          cirrusServers.set(connection.address, cirrusServer);
          console.log("Connection not found in Map() -- adding a new one");
        }
      }
    } else if (message.type === "streamerConnected") {
      // The stream connects to a Cirrus server and so is ready to be used
      cirrusServer = cirrusServers.get(connection.address);
      if (cirrusServer) {
        cirrusServer.ready = true;
        console.log(
          `Cirrus server ${cirrusServer.address} ready for use`
        );
      } else {
        disconnect(connection);
      }
    } else if (message.type === "streamerDisconnected") {
      // The stream connects to a Cirrus server and so is ready to be used
      cirrusServer = cirrusServers.get(connection.address);
      if (cirrusServer) {
        cirrusServer.ready = false;
        console.log(
          `Cirrus server ${cirrusServer.address} no longer ready for use`
        );
      } else {
        disconnect(connection);
      }
    } else if (message.type === "clientConnected") {
      // A client connects to a Cirrus server.
      if (cirrusServer) {
        cirrusServer = cirrusServers.get(connection.address);
        cirrusServer.index = connectionIndex++;
        cirrusServer.clientConnected = true;

        console.log(
          `Client connected to Cirrus server ${cirrusServer.address}`
        );
      } else {
        disconnect(connection);
      }
    } else if (message.type === "clientDisconnected") {
      // A client disconnects from a Cirrus server.
      cirrusServer = cirrusServers.get(connection.address);
      if (cirrusServer) {
        cirrusServer.clientConnected = false;
        console.log(
          `Client disconnected from Cirrus server ${cirrusServer.address}`
        );
        if (!cirrusServer.clientConnected) {
          // this make this server immediately available for a new client
          cirrusServer.lastRedirect = 0;
        }
      } else {
        disconnect(connection);
      }
    } else if (message.type === "ping") {
      cirrusServer = cirrusServers.get(connection.address);
      if (cirrusServer) {
        cirrusServer.lastPingReceived = Date.now();
      } else {
        disconnect(connection);
      }
    } else {
      console.log("ERROR: Unknown data: " + JSON.stringify(message));
      disconnect(connection);
    }
  });

  // A Cirrus server disconnects from this Matchmaker server.
  connection.on("error", () => {
    cirrusServer = cirrusServers.get(connection.address);
    if (cirrusServer) {
      cirrusServers.delete(connection.address);
      console.log(
        `Cirrus server ${cirrusServer.address} disconnected from Matchmaker`
      );
    } else {
      console.log(
        `Disconnected machine that wasn't a registered cirrus server, remote address: ${connection.remoteAddress}`
      );
    }
  });
});

matchmaker.listen(config.MatchmakerPort, () => {
  console.log("Matchmaker listening on *:" + config.MatchmakerPort);
});
