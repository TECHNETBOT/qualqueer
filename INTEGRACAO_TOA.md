# Integração TOA (Extensão → Bot WhatsApp)

O bot agora sobe um webhook HTTP local para receber contatos extraídos do TOA.

## Endpoint

- `POST /toa/sync`
- Porta padrão: `8787` (configurável via `TOA_BRIDGE_PORT`)
- Token opcional via header `x-toa-token` (configurável por `TOA_BRIDGE_TOKEN`)

Exemplo:

```bash
curl -X POST "http://127.0.0.1:8787/toa/sync" \
  -H "content-type: application/json" \
  -H "x-toa-token: SEU_TOKEN" \
  -d '{
    "source":"toa-extension",
    "entries":[
      {"contrato":"1234567","telefones":["84999990000","84988887777"],"aid":"123456789"}
    ]
  }'
```

## Snippet para colar no `content.js` da extensão

Após montar o `final` no `window.tnExportContatosLote`, envie para o bot:

```js
try {
  const entries = final.map(x => ({
    contrato: x.contrato,
    telefones: String(x.telefones || '').split('/').map(v => v.trim()).filter(Boolean)
  }));

  await fetch('http://127.0.0.1:8787/toa/sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 'x-toa-token': 'SEU_TOKEN'
    },
    body: JSON.stringify({ source: 'toa-extension', entries })
  });
} catch (err) {
  console.warn('Falha ao sincronizar com bot:', err);
}
```

## Uso no WhatsApp

No grupo de controladores:

- `contatos 1234567` → consulta primeiro no cache TOA (webhook), fallback para planilha.
- `!toastatus` → mostra contagem atual do cache TOA.