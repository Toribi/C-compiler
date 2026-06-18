const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TMP_DIR = "/tmp/c-compiler";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  try {
    fs.readdirSync(TMP_DIR).forEach((f) => {
      const full = path.join(TMP_DIR, f);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > 5 * 60 * 1000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    });
  } catch (_) {}
}, 60_000);

app.get("/health", (_, res) => res.json({ ok: true }));

wss.on("connection", (ws) => {
  let childProcess = null;
  let sessionDir = null;

  function send(type, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // --- COMPILE + RUN ---
    if (msg.type === "run") {
      // Kill any existing process
      if (childProcess) {
        try { childProcess.kill("SIGKILL"); } catch (_) {}
        childProcess = null;
      }

      const id = uuidv4();
      sessionDir = path.join(TMP_DIR, id);
      fs.mkdirSync(sessionDir, { recursive: true });

      const srcPath = path.join(sessionDir, "main.c");
      const binPath = path.join(sessionDir, "main");

      fs.writeFileSync(srcPath, msg.data);
      send("status", "compiling");

      // Compile
      const gcc = spawn("gcc", [
        "-o", binPath,
        srcPath,
        "-lm",
        "-Wall",
        "-std=c11",
      ]);

      let compileErr = "";
      gcc.stderr.on("data", (d) => { compileErr += d.toString(); });

      gcc.on("close", (code) => {
        if (code !== 0) {
          send("compile_error", compileErr);
          send("status", "idle");
          return;
        }

        send("status", "running");
        send("output", ""); // clear signal

        // CORREÇÃO DO SCANF: Adicionado stdio: ["pipe", "pipe", "pipe"] para criar os canais de texto
        childProcess = spawn(binPath, [], {
          cwd: sessionDir,
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"]
        });

        childProcess.stdout.on("data", (d) => send("output", d.toString()));
        childProcess.stderr.on("data", (d) => send("output", d.toString()));

        childProcess.on("close", (exitCode, signal) => {
          if (signal === "SIGKILL") {
            send("output", "\n[Processo encerrado por timeout ou pelo usuário]\n");
          } else {
            send("output", `\n[Processo encerrado com código ${exitCode}]\n`);
          }
          send("status", "idle");
          childProcess = null;
        });

        childProcess.on("error", (err) => {
          send("output", `\n[Erro ao executar: ${err.message}]\n`);
          send("status", "idle");
        });
      });

      gcc.on("error", () => {
        send("compile_error", "gcc não encontrado no servidor.");
        send("status", "idle");
      });
    }

    // --- STDIN INPUT ---
    if (msg.type === "input") {
      if (childProcess && childProcess.stdin && !childProcess.stdin.destroyed) {
        try {
          childProcess.stdin.write(msg.data);
        } catch (_) {}
      }
    }

    // --- KILL ---
    if (msg.type === "kill") {
      if (childProcess) {
        try { childProcess.kill("SIGKILL"); } catch (_) {}
        childProcess = null;
      }
      send("status", "idle");
    }
  });

  ws.on("close", () => {
    if (childProcess) {
      try { childProcess.kill("SIGKILL"); } catch (_) {}
    }
    if (sessionDir) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
