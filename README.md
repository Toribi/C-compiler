# C/run — Compilador C Online Pessoal

Editor com Monaco (mesmo do VS Code) + terminal interativo via WebSocket. Grátis para uso pessoal.

---

## Estrutura

```
c-compiler/
├── backend/        ← Node.js + gcc  (deploy no Railway)
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
└── frontend/       ← HTML puro  (deploy no GitHub Pages)
    └── index.html
```

---

## Deploy — Backend (Railway)

1. Crie uma conta gratuita em [railway.app](https://railway.app)
2. No dashboard, clique em **New Project → Deploy from GitHub repo**
3. Selecione seu repositório e aponte para a pasta `backend/`
4. Railway detecta o `Dockerfile` automaticamente
5. Após o deploy, copie a URL pública (ex: `meu-app.railway.app`)
6. Converta para WebSocket: `wss://meu-app.railway.app`

> **Plano gratuito do Railway:** 500 horas/mês — suficiente para uso pessoal.

---

## Deploy — Frontend (GitHub Pages)

1. Suba o conteúdo de `frontend/` para um repositório GitHub
2. Vá em **Settings → Pages → Branch: main → Folder: / (root)**
3. Salve — em ~1 min seu site estará em `https://seu-usuario.github.io/repo`

---

## Como usar

1. Abra o frontend no browser
2. Cole a URL WebSocket do Railway no campo no topo (ex: `wss://meu-app.railway.app`)
3. Pressione **Enter** para conectar
4. Escreva seu código C no editor
5. Clique **▶ Executar**
6. Interaja com o programa diretamente no terminal à direita

A URL do servidor é salva automaticamente no localStorage — você não precisa redigitar.

---

## Funcionalidades

- Editor Monaco com syntax highlighting para C
- Terminal interativo (xterm.js) com suporte a `scanf`, `fgets`, etc.
- Compilação com `gcc -Wall -std=c11 -lm`
- Erros de compilação exibidos no terminal com destaque
- Botão **Parar** para encerrar o processo
- Timeout automático de 10 segundos para evitar loops infinitos
- Divisor arrastável entre editor e terminal
- Tema escuro consistente (Catppuccin Mocha)

---

## Segurança

O servidor executa código arbitrário — **use apenas para uso pessoal**. Não exponha publicamente sem adicionar autenticação.

Para adicionar uma senha simples, adicione no topo do `server.js`:

```js
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('token') !== process.env.SECRET_TOKEN) {
    ws.close();
    return;
  }
  // ... resto do código
});
```

E conecte com: `wss://seu-app.railway.app?token=sua-senha`
