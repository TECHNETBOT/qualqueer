// src/config.js
module.exports = {
    // URLs das Planilhas
    URL_NATAL: 'https://docs.google.com/spreadsheets/d/1ekbmoobOkE5CWkd5L_fIlXm1s_SUNOscy8Qh8TYahhQ/export?format=csv&gid=1613245670',
    URL_FORTALEZA: 'https://docs.google.com/spreadsheets/d/1ekbmoobOkE5CWkd5L_fIlXm1s_SUNOscy8Qh8TYahhQ/export?format=csv&gid=0',
    URL_NOVA_TABELA: 'https://docs.google.com/spreadsheets/d/1briXyqJVDxEIPUKYAZRN-Uk60M9fijtEDFahqH1knG8/export?format=csv&gid=0',

    // Configurações do Backlog (Fora Rota)
    BACKLOG_SHEET_ID: '1r0_l5QIlx8OaF1l19wZlkn9scNI8vZkoS4VH5jPVHjw',
    BACKLOG_GID: '0',

    // IDs dos Grupos
    ID_GRUPO_TECNICOS: '120363422121095440@g.us',
    ID_GRUPO_ALERTAS: '558488045008-1401380014@g.us',
    ID_TESTE_EXCLUSIVO: '120363423496684075@g.us',

    // Caminhos dos Arquivos JSON
    ARQ_GRUPOS_AUTORIZADOS: './grupos_autorizados.json',
    ARQ_DONOS: './donos.json',
    ARQ_LID_CACHE: './lid_cache.json',
    ARQUIVO_VT: './marcacoes_vt.json',
    ARQUIVO_AD: './marcacoes_ad.json',
    ARQUIVO_DESC: './marcacoes_desc.json',
    FORAROTA_STATE_FILE: './forarota_state.json',

    // Tempos de Cache
    CONTRATOS_CACHE_TTL_MS: 5 * 60 * 1000,
    BACKLOG_CACHE_TTL_MS: 2 * 60 * 1000
};