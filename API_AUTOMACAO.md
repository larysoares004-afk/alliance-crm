# API de Integração — Alliance CRM
### Documentação para Equipe de Automação (N8N / IA)

---

## Visão Geral

O Alliance CRM já está conectado ao WhatsApp e Instagram via Meta API.
A equipe de automação **não precisa se conectar diretamente à Meta** — apenas ao CRM.

```
N8N / IA  ←→  Alliance CRM  ←→  Meta (WhatsApp / Instagram)
```

---

## Credenciais necessárias

Solicite à Laryssa os seguintes dados:

| Item | Descrição |
|---|---|
| `BASE_URL` | URL do CRM no Railway (ex: `https://alliance-crm.up.railway.app`) |
| `token_ia` | Token secreto de autenticação da IA (configurado nas Settings do CRM) |

---

## FLUXO 1 — CRM envia mensagem para o N8N

Quando um cliente manda mensagem no WhatsApp ou Instagram, o CRM chama automaticamente o webhook do N8N.

### Você (N8N) precisa fornecer:
- Uma **URL de webhook** para receber as mensagens (ex: `https://n8n.seuservidor.com/webhook/alliance`)
- Essa URL é cadastrada nas **Configurações do CRM → Seção IA/N8N**

### Payload que o CRM envia para o N8N:

```json
{
  "canal": "whatsapp",
  "de": "5511999999999",
  "nome": "João Silva",
  "texto": "Oi, quero agendar uma consulta",
  "timestamp": "2026-03-31T14:30:00.000Z",
  "token_ia": "SEU_TOKEN_AQUI"
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `canal` | string | `"whatsapp"` ou `"instagram"` |
| `de` | string | Telefone (WhatsApp) ou ID numérico (Instagram) |
| `nome` | string | Nome do contato |
| `texto` | string | Texto da mensagem recebida |
| `timestamp` | string | Data/hora em ISO 8601 |
| `token_ia` | string | Token para validar autenticidade |

> ⚠️ **Valide o `token_ia`** recebido para garantir que a requisição veio do CRM e não de terceiros.

---

## FLUXO 2 — N8N envia resposta pelo CRM

Após processar a mensagem com IA, o N8N deve enviar a resposta **para o CRM**, que entrega ao cliente e registra no histórico.

### Endpoint:

```
POST {BASE_URL}/api/ia/resposta
```

### Headers:

```
Content-Type: application/json
```

### Body:

```json
{
  "canal": "whatsapp",
  "para": "5511999999999",
  "texto": "Olá João! Posso te ajudar a agendar. Qual data prefere?",
  "token_ia": "SEU_TOKEN_AQUI"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `canal` | string | ✅ | `"whatsapp"` ou `"instagram"` |
| `para` | string | ✅ | Telefone (WhatsApp) ou ID numérico (Instagram) — apenas dígitos |
| `texto` | string | ✅ | Texto da resposta da IA |
| `token_ia` | string | ✅ | Token secreto (o mesmo recebido no Fluxo 1) |

### Resposta de sucesso:

```json
{
  "ok": true
}
```

### Resposta de erro (token inválido):

```json
{
  "erro": "Token IA inválido"
}
```
> HTTP 401

### Resposta de erro (campos faltando):

```json
{
  "erro": "para e texto obrigatórios"
}
```
> HTTP 400

---

## Exemplo de fluxo completo no N8N

```
[Webhook Trigger] ← CRM envia mensagem do cliente
       ↓
[Processar com IA] (ChatGPT, Claude, etc.)
       ↓
[HTTP Request] POST /api/ia/resposta → CRM envia ao cliente
```

---

## Casos especiais

### Novo Lead (Landing Page)
Quando um novo lead se cadastra via formulário, o CRM também dispara para o N8N com o seguinte texto:

```
[NOVO LEAD] João Silva se cadastrou na landing page.
Unidade: Barra. Motivo: Exame de Vista.
Telefone: 5511999999999.
Inicie a conversa de agendamento com ele.
```

O N8N pode usar esse gatilho para iniciar uma conversa automática de boas-vindas/agendamento.

---

## Rate Limit

O endpoint `/api/ia/resposta` aceita no máximo **60 requisições por minuto** por IP.

---

## Observações importantes

- O CRM já gerencia o envio para WhatsApp e Instagram — **não chame a API da Meta diretamente**
- Para Instagram, o campo `para` deve ser o **ID numérico** do usuário (ex: `"17841234567890"`), não o @username
- Para WhatsApp, o campo `para` deve conter o **DDI + DDD + número** sem formatação (ex: `"5511999999999"`)
- Todas as mensagens enviadas via `/api/ia/resposta` aparecem no histórico do CRM com o nome **"IA Alliance"**

---

## Configuração no CRM (feita pela Laryssa)

Na tela de **Configurações do CRM → IA / N8N**:
1. Inserir a URL do webhook do N8N
2. Definir o `token_ia` secreto
3. Salvar

Após salvar, o CRM começa a disparar automaticamente para o N8N a cada mensagem recebida.

---

*Documentação gerada para o Alliance CRM — LS Marketing*
*Dúvidas: contato com Laryssa*
