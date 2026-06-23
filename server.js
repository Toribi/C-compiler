var express = require("express");
var http = require("http");
var WebSocket = require("ws");
var axios = require("axios"); // NOVO: Para fazer requisições na API gratuita
var cors = require("cors");

var app = express();
app.use(cors());
app.use(express.json());

var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });

app.get("/health", function(_, res) { res.json({ ok: true }); });

wss.on("connection", function(ws) {
  console.log("NOVO CLIENTE CONECTADO");

  function send(type, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: type, data: data }));
    }
  }

  // Adicionamos 'async' para poder usar o 'await'
  ws.on("message", async function(raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (msg.type === "run") {
      send("status", "compiling");

      try {
        // Envia o código para o Piston (API gratuita e segura)
        var response = await axios.post('https://emkc.org/api/v2/piston/execute', {
          language: "c",
          version: "10.2.0", // Versão do GCC disponível no servidor deles
          files: [
            {
              content: msg.data // O código C digitado pelo usuário
            }
          ],
          compile_timeout: 5000, // 5 segundos para compilar
          run_timeout: 3000,     // 3 segundos para rodar (evita loops infinitos travarem a req)
          memory_limit: 50000000 // 50MB de RAM
        });

        var resultado = response.data;

        // 1. Verifica se houve erro de COMPILAÇÃO
        if (resultado.compile && resultado.compile.stderr) {
          send("compile_error", resultado.compile.stderr);
          send("status", "idle");
          return;
        }

        // 2. Se não deu erro de compilação, altera o status para rodando
        send("status", "running");
        send("output", "");

        // 3. Verifica o resultado da EXECUÇÃO
        if (resultado.run) {
          // Manda erros de execução (ex: segmentation fault)
          if (resultado.run.stderr) {
            send("output", resultado.run.stderr);
          }
          // Manda a saída normal (printf)
          if (resultado.run.stdout) {
            send("output", resultado.run.stdout);
          }

          // Trata o final do processo
          if (resultado.run.signal === "SIGKILL" || resultado.run.signal === "SIGXFSZ") {
            send("output", "\n[Processo encerrado por timeout ou limite de memoria]\n");
          } else if (resultado.run.code !== 0) {
            send("output", "\n[Processo encerrado com codigo " + resultado.run.code + "]\n");
          } else {
            send("output", "\n[Processo encerrado com sucesso]\n");
          }
        }

        send("status", "idle");

      } catch (err) {
        console.error("Erro na API Piston:", err.message);
        
        // Se o usuário clicar muito rápido, a API bloqueia (Rate Limit)
        if (err.response && err.response.status === 429) {
          send("compile_error", "Muitas requisições. Aguarde 3 segundos e tente novamente.");
        } else {
          send("compile_error", "Erro ao conectar com o servidor de compilação.");
        }
        send("status", "idle");
      }
    }

    // NOTA: O "input" e o "kill" foram removidos porque a API do Piston 
    // não é interativa em tempo real. O código inteiro roda de uma vez.
  });

  ws.on("close", function() {
    console.log("CLIENTE DESCONECTADO");
  });
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
