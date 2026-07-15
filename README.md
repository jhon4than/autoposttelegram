# AutoPost Telegram

Painel privado para armazenar imagens e vídeos e publicá-los, uma única vez por grupo/canal, usando a Telegram Bot API.

## Produção

- Volume persistente: `/data`
- Porta: `3000`
- Healthcheck: `/api/health`
- Limite por arquivo: 50 MB (limite atual da Bot API)

```bash
cp .env.example .env
npm install
npm run dev
```
