var express = require("express");
var http = require("http");
var WebSocket = require("ws");
var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var uuidv4 = require("uuid").v4;
var cors = require("cors");

var app = express();
app.use(cors());
app.use(express.json());

var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });

var TMP_DIR = "/tmp/c-compiler";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

setInterval(function() {
  var now = Date.now();
  try {
    fs.readdirSync(TMP_DIR).forEach(function(f) {
      var full = path.join(TMP_DIR, f);
      var stat = fs.statSync(full);
      if (now - stat.mtimeMs > 5 * 60 * 1000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    });
  } catch (_) {}
}, 60000);

app.get("/health", function(_, res) { res.json({ ok: true }); });

function limparErroGCC(erro) {
  // Remove o caminho completo, deixa so "main.c:"
  erro = erro.replace(/\/tmp\/c-compiler\/[^\/]+\/main\.c:/g, "main.c:");

  // Remove linhas do linker e collect2 (pouco uteis para o usuario)
  var linhas = erro.split("\n");
  var filtradas = [];
  for (var i = 0; i < linhas.length; i++) {
    var l = linhas[i];
    if (/^\/usr\/bin\/ld:/.test(l)) continue;
    if (/^collect2:/.test(l)) continue;
    if (/^main\.c:\(.text/.test(l)) continue;
    filtradas.push(l);
  }
  return filtradas.join("\n");
}

function ajustarLinhasErro(erro, offset) {
  if (offset <= 0) return erro;
  erro = erro.replace(/(main\.c:)(\d+)(:)/g, function(_, pre, num, pos) {
    var novaLinha = Math.max(1, parseInt(num) - offset);
    return pre + novaLinha + pos;
  });
  erro = erro.replace(/^(\s*)(\d+) (\|)/gm, function(_, spaces, num, pipe) {
    var novaLinha = Math.max(1, parseInt(num) - offset);
    return spaces + novaLinha + " " + pipe;
  });
  return erro;
}

function filtrarErrosDoPrefixo(erro, offset) {
  var linhas = erro.split("\n");
  var filtradas = [];
  var i = 0;
  while (i < linhas.length) {
    var linha = linhas[i];
    var match = linha.match(/main\.c:(\d+):/);
    if (match && parseInt(match[1]) <= offset) {
      i++;
      while (i < linhas.length && /^\s*\d+\s*\|/.test(linhas[i])) i++;
      while (i < linhas.length && /^\s*(note:|  \+\+\+)/.test(linhas[i])) i++;
      continue;
    }
    filtradas.push(linha);
    i++;
  }
  return filtradas.join("\n").trim();
}

wss.on("connection", function(ws) {
  var childProcess = null;
  var sessionDir = null;

  function send(type, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: type, data: data }));
    }
  }

  ws.on("message", function(raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (msg.type === "run") {
      if (childProcess) {
        try { childProcess.kill("SIGKILL"); } catch (_) {}
        childProcess = null;
      }

      var id = uuidv4();
      sessionDir = path.join(TMP_DIR, id);
      fs.mkdirSync(sessionDir, { recursive: true });

      var srcPath = path.join(sessionDir, "main.c");
      var binPath = path.join(sessionDir, "main");

      var PREFIXO_LINHAS = 2;
      var prefixo = "#include <stdio.h>\n" +
        "__attribute__((constructor)) void _desativar_buffer() { setvbuf(stdout, NULL, _IONBF, 0); }\n";

      var codigoTratado = prefixo + msg.data;
      fs.writeFileSync(srcPath, codigoTratado);
      send("status", "compiling");

      var gcc = child_process.spawn("gcc", [
        "-o", binPath,
        srcPath,
        "-lm",
        "-Wall",
        "-std=c11"
      ]);

      var compileErr = "";
      gcc.stderr.on("data", function(d) { compileErr += d.toString(); });

      gcc.on("close", function(code) {
        if (code !== 0) {
          var erroLimpo = limparErroGCC(compileErr);
          var erroFiltrado = filtrarErrosDoPrefixo(compileErr, PREFIXO_LINHAS);
          var erroFinal = ajustarLinhasErro(erroFiltrado, PREFIXO_LINHAS);
          if (erroFinal.trim()) {
            send("compile_error", erroFinal);
          } else {
            send("compile_error", "Erro de compilacao (detalhes filtrados).\n");
          }
          send("status", "idle");
          return;
        }

        send("status", "running");
        send("output", "");

        childProcess = child_process.spawn(binPath, [], {
          cwd: sessionDir,
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"]
        });

        childProcess.stdout.on("data", function(d) { send("output", d.toString()); });
        childProcess.stderr.on("data", function(d) { send("output", d.toString()); });

        childProcess.on("close", function(exitCode, signal) {
          if (signal === "SIGKILL") {
            send("output", "\n[Processo encerrado por timeout ou pelo usuario]\n");
          } else {
            send("output", "\n[Processo encerrado com codigo " + exitCode + "]\n");
          }
          send("status", "idle");
          childProcess = null;
        });

        childProcess.on("error", function(err) {
          send("output", "\n[Erro ao executar: " + err.message + "]\n");
          send("status", "idle");
        });
      });

      gcc.on("error", function() {
        send("compile_error", "gcc nao encontrado no servidor.");
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

  ws.on("close", function() {
    if (childProcess) {
      try { childProcess.kill("SIGKILL"); } catch (_) {}
    }
    if (sessionDir) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
