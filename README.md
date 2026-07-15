# AutoPost Telegram

Painel privado para armazenar imagens e vídeos e publicá-los, uma única vez por grupo/canal, usando a Telegram Bot API.

## Produção

- Volume persistente: `/data`
- Porta: `3000`
- Healthcheck: `/api/health`
- Limite por arquivo: até 2 GB quando conectado ao servidor local da Bot API
- O serviço `telegram-bot-api` compartilha o volume `/data`, permitindo envio por caminho local sem carregar o vídeo inteiro na RAM.

```bash
cp .env.example .env
npm install
npm run dev
```
