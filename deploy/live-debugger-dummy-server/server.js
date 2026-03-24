const fs = require("fs");
const http = require("http");
const net = require("net");

const port = Number(process.env.PORT || 8080);
const errorIntervalMs = Number(process.env.ERROR_INTERVAL_MS || 5000);
const dbHost = process.env.DUMMY_DB_HOST || "127.0.0.1";
const dbPort = Number(process.env.DUMMY_DB_PORT || 5432);

function formatMessage(level, message) {
  return `${new Date().toISOString()} ${level} dummy-server ${message}`;
}

function log(level, message, error) {
  const line = formatMessage(level, message);
  if (level === "ERROR" || level === "WARN") {
    console.error(line);
  } else {
    console.log(line);
  }

  if (error) {
    console.error(error.stack || error.message || String(error));
  }
}

function simulateDatabaseFailure() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: dbHost, port: dbPort });

    socket.on("connect", () => {
      socket.destroy();
      log(
        "WARN",
        `Unexpectedly connected to ${dbHost}:${dbPort}; this fixture expects connection failures.`,
      );
      resolve();
    });

    socket.on("error", (error) => {
      log(
        "ERROR",
        `Background worker failed to reach postgres at ${dbHost}:${dbPort}`,
        error,
      );
      resolve();
    });
  });
}

function simulateMissingFile() {
  try {
    fs.readFileSync("/app/runtime/secrets.json", "utf8");
  } catch (error) {
    log(
      "ERROR",
      "Config loader could not read /app/runtime/secrets.json",
      error,
    );
  }
}

function simulateTypeError() {
  try {
    const payload = null;
    return payload.user.id;
  } catch (error) {
    log(
      "ERROR",
      "Request handler crashed while building the JSON response",
      error,
    );
    return null;
  }
}

async function runBackgroundFailures() {
  log("INFO", "Running scheduled failure scenarios.");
  await simulateDatabaseFailure();
  simulateMissingFile();
  simulateTypeError();
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "dummy-server" }));
    return;
  }

  if (req.url === "/crash") {
    try {
      JSON.parse('{"broken":}');
    } catch (error) {
      log("ERROR", "Route /crash raised a JSON parse exception", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: "Intentional crash route failed." }),
      );
      return;
    }
  }

  if (req.url === "/db-check") {
    await simulateDatabaseFailure();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "Database check failed as intended.",
      }),
    );
    return;
  }

  log("INFO", `Handled ${req.method} ${req.url}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      service: "dummy-server",
      routes: ["/health", "/crash", "/db-check"],
    }),
  );
});

server.listen(port, () => {
  log("INFO", `Dummy server listening on 0.0.0.0:${port}`);
  log(
    "WARN",
    "This container intentionally emits runtime errors for live debugger testing.",
  );
  void runBackgroundFailures();
});

setInterval(() => {
  void runBackgroundFailures();
}, errorIntervalMs);

process.on("uncaughtException", (error) => {
  log("ERROR", "Uncaught exception reached process handler", error);
});

process.on("unhandledRejection", (reason) => {
  log("ERROR", "Unhandled promise rejection reached process handler", reason);
});
