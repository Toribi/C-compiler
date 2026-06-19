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

/**
 * Ajusta os números de linha nos erros do GCC subtraindo o offset
 * causado pelas 2 linhas injetadas no início do código.
 */
function ajustarLinhasErro(erro, offset) {
  if (offset <= 0) return erro;

  // Padrão: main.c:LINHA:COL: warning/error: ...
  erro = erro.replace(/(main\.c:)(\d+)(:)/g, (_, pre, num, pos) => {
    const novaLinha = Math.max(1, parseInt(num) - offset);
    return pre + novaLinha + pos;
  });

  // Padrão: espaços + LINHA + " |" (carets de contexto do GCC)
  erro = erro.replace(/^(\s*)(\d+) (\|)/gm, (_, spaces, num, pipe) => {
    const novaLinha = Math.max(1, parseInt(num) - offset);
    return spaces + novaLinha + " " + pipe;
  });

  return erro;
}

/**
 * Remove do erro do GCC qualquer menção às linhas injetadas (1 e 2).
 * Se o único erro for nas linhas do prefixo, retorna string vazia
 * (não deveria acontecer, mas previne lixo na saída).
 */
function filtrarErrosDoPrefixo(erro, offset) {
  // Remove linhas inteiras do erro que referenciam linhas do prefixo
  const linhas = erro.split("\n");
  const filtradas = [];
  let i = 0;
  while (i < linhas.length) {
    const linha = linhas[i];
    // Detecta padrão "main.c:NUM:" — se NUM <= offset, pula essa linha e o caret abaixo
    const match = linha.match(/main\.c:(\d+):/);
    if (match && parseInt(match[1]) <= offset) {
      // Pula a linha do erro
      i++;
      // Pula possíveis linhas de contexto (carets) que seguem
      while (i < linhas.length && /^\s*\d+\s*\|/.test(linhas[i])) i++;
      // Pula linhas de "note:" ou "+++ |+#include" associadas
      while (i < linhas.length && /^\s*(note:|  \+\+\+)/.test(linhas[i])) i++;
      continue;
    }
    filtradas.push(linha);
    i++;
  }
  return filtradas.join("\n").trim();
}

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

    if (msg.type === "run") {
      if (childProcess) {
        try { childProcess.kill("SIGKILL"); } catch (_) {}
        childProcess = null;
      }

      const id = uuidv4();
      sessionDir = path.join(TMP_DIR, id);
      fs.mkdirSync(sessionDir, { recursive: true });

      const srcPath = path.join(sessionDir, "main.c");
      const binPath = path.join(sessionDir, "main");

      // Sempre inclui stdio.h antes do constructor.
      // Headers padrão têm include guards, então duplicar não causa problema.
      const PREFIXO_LINHAS = 2;
      const prefixo =
        "#include <stdio.h>\n" +
        "__attribute__((constructor)) void _desativar_buffer() { setvbuf(stdout, NULL, _IONBF, 0); }\n";

      const codigoTratado = prefixo + msg.data;
      fs.writeFileSync(srcPath, codigoTratado);
      send("status", "compiling");

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
          // 1º: remove erros que se referem às linhas do prefixo
          let erroFiltrado = filtrarErrosDoPrefixo(compileErr, PREFIXO_LINHAS);

          // 2º: ajusta os números de linha restantes subtraindo o offset
          let erroFinal = ajustarLinhasErro(erroFiltrado, PREFIXO_LINHAS);

          // Se sobrou algo, envia; senão envia mensagem genérica
          if (erroFinal.trim()) {
            send("compile_error", erroFinal);
          } else {
            send("compile_error", "Erro de compilação (detalhes filtrados).\n");
          }
          send("status", "idle");
          return;
        }

        send("status", "running");
        send("output", "");

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
            send("output", `\n[Processo encerrado com código ${exitCode}]\n");
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

    if (msg.type === "input") {
      if (childProcess && childProcess.stdin && !childProcess.stdin.destroyed) {
        try {
          childProcess.stdin.write(msg.data);
        } catch (_) {}
      }
    }

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
