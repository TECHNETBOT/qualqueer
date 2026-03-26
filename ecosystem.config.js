module.exports = {
  apps: [{
    name: 'Bot',
    script: 'index.js',
    env: {
      // IA — Mistral AI
      // Gera chave em: https://console.mistral.ai/api-keys
      MISTRAL_API_KEY: 'OaqQxpN1Q1HnsMQM9KBYj0a24oxmDpD3',

      // Bot
      BOT_BUILD: 'v30',

      // TOA Bridge
      TOA_BRIDGE_PORT:        '8787',
      TOA_BRIDGE_HOST:        '127.0.0.1',
      TOA_BRIDGE_TOKEN:       '',
      TOA_AUTO_LOGIN_ENABLED: '1',

      PYTHON_BIN: 'python3',
    }
  }]
}