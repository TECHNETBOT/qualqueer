(function () {
  "use strict";

  const state = {
    currentAid: null,
    currentContract: null,
    byAid: new Map(),       // aid -> ctx
    byContract: new Map(),  // contrato -> ctx
    minimized: false,
    pos: { x: null, y: null },

    // batch/export
    template: null,          // { url, method, entries: [[k,v],...] }
    lastExport: null,        // array resultados
    exportStatus: "Aguardando dados...",
    exporting: false,
    lastTemplateAt: null,

    // NEW: cache de AIDs visto via sync (mesmo sem aparecer no DOM)
    seenAids: new Set(),     // string aid
    lastSyncAt: null,
  };

  // =========================
  // UTIL
  // =========================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // =========================
  // SYNC COM BOT (envia para bridge local)
  // =========================
  const BOT_BRIDGE_HOST = '127.0.0.1';
  const BOT_BRIDGE_PORT = 8787;
  const BOT_BRIDGE_TOKEN = ''; // preencha se usar TOA_BRIDGE_TOKEN

  // Debounce: evita spam de requests (1 envio a cada 1.5s por contrato)
  const _syncPending = new Map();

  function syncCtxComBot(ctx) {
    if (!ctx || !ctx.contrato || !ctx.contatos || ctx.contatos.size === 0) return;
    const contrato = String(ctx.contrato).replace(/\D/g, '');
    if (!contrato || contrato.length < 6) return;

    // Debounce por contrato
    if (_syncPending.has(contrato)) clearTimeout(_syncPending.get(contrato));
    _syncPending.set(contrato, setTimeout(async () => {
      _syncPending.delete(contrato);
      const telefones = Array.from(ctx.contatos).filter(t => t && t.length >= 10);
      if (!telefones.length) return;

      const payload = {
        source: 'toa-extension',
        entries: [{
          contrato,
          telefones,
          aid: String(ctx.aid || ''),
          tecnico: ctx.tecnico || '',
          nome: ctx.nome || '',
          janela: ctx.horario || '',
        }]
      };

      console.log('[TOA-SYNC] →', contrato, telefones);
      try {
        const resp = await fetch(`http://${BOT_BRIDGE_HOST}:${BOT_BRIDGE_PORT}/toa/sync`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(BOT_BRIDGE_TOKEN ? { 'x-toa-token': BOT_BRIDGE_TOKEN } : {}),
          },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        console.log('[TOA-SYNC] ✅ bridge aceitou:', data.inserted, 'entrada(s). Stats:', data.stats);
      } catch (err) {
        console.warn('[TOA-SYNC] ⚠ bridge indisponível:', err.message,
          `(verifique se o bot está em http://${BOT_BRIDGE_HOST}:${BOT_BRIDGE_PORT})`);
      }
    }, 1500));
  }

  // Envia todos os contratos que já estão no cache da extensão
  async function syncTodosComBot() {
    const entries = [];
    for (const [, ctx] of state.byContract) {
      if (!ctx.contrato || ctx.contatos.size === 0) continue;
      entries.push({
        contrato: String(ctx.contrato).replace(/\D/g, ''),
        telefones: Array.from(ctx.contatos).filter(t => t && t.length >= 10),
        aid: String(ctx.aid || ''),
        tecnico: ctx.tecnico || '',
        nome: ctx.nome || '',
      });
    }
    if (!entries.length) {
      console.log('[TOA-SYNC] syncTodos: nenhum contrato com telefone no cache ainda.');
      return;
    }
    try {
      const resp = await fetch(`http://${BOT_BRIDGE_HOST}:${BOT_BRIDGE_PORT}/toa/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(BOT_BRIDGE_TOKEN ? { 'x-toa-token': BOT_BRIDGE_TOKEN } : {}),
        },
        body: JSON.stringify({ source: 'toa-extension-batch', entries }),
      });
      const data = await resp.json();
      console.log(`[TOA-SYNC] ✅ syncTodos: ${data.inserted} inserido(s). Stats:`, data.stats);
    } catch (err) {
      console.warn('[TOA-SYNC] ⚠ syncTodos falhou:', err.message);
    }
  }



  function formatPhone(raw) {
    if (!raw) return null;
    let d = String(raw).replace(/\D+/g, "");
    if (d.length < 10) return null;
    if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
    return d;
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  // =========================
  // CAPTURA DOM (OS aberta)
  // =========================
  function getElementByText(text) {
    const all = document.querySelectorAll("div, span, label, td, p");
    for (let el of all) {
      if (el.innerText && el.innerText.trim() === text && el.nextElementSibling) {
        return el.nextElementSibling.innerText.trim();
      }
    }
    return "";
  }

  function getTechName() {
    let techElement = document.querySelector(
      ".of-activity-details-header-subtitle, .v-activity-header-subtitle, .activity-details-subtitle, " +
      '[class*="header-subtitle"], [class*="activity-header"], [class*="details-header"], ' +
      ".activity-header, .details-header-subtitle"
    );

    if (!techElement) {
      techElement = Array.from(document.querySelectorAll("div, span, p, label, h1, h2, h3, strong"))
        .find(el => {
          const txt = (el.innerText || "").trim();
          return (txt.includes("/") && txt.match(/\d{2}\/\d{2}\/\d{2,4}/)) && txt.length < 150;
        });
    }

    if (techElement) {
      let text = (techElement.innerText || "")
        .replace(/Detalhes da atividade/gi, "")
        .replace(/,?\s*\d{2}\/\d{2}\/\d{2,4}.*/gi, "")
        .replace(/\s*,\s*/g, " ")
        .trim();

      const parts = text.split(/[,|–|-]/);
      let nome = (parts[0] || "").trim();
      if (nome.length > 5 && !nome.match(/^\d/)) return nome;
    }

    return "Técnico não identificado";
  }

  function getComplemento() {
    return getElementByText("Complemento Endereço") || "";
  }

  function getEquipmentData() {
    const linhas = document.querySelectorAll("tr");
    let dados = { modelo: "", serial: "" };

    linhas.forEach(linha => {
      const cols = linha.querySelectorAll("td");
      const rowText = (linha.innerText || "").toLowerCase();

      if (rowText.includes("instalado")) {
        const mod = cols[2] ? cols[2].innerText.trim() : "";
        const ser = cols[3] ? cols[3].innerText.trim() : "";
        if (ser !== "" || mod !== "") {
          dados.modelo = mod;
          dados.serial = ser;
        }
      }
    });

    return dados;
  }

  function getContractFromScreen() {
    const c = getElementByText("Contrato");
    return c ? c.replace(/\D/g, "") : null;
  }

  function getActiveAidFromUrl() {
    const match = window.location.href.match(/aid=(\d+)/) || window.location.href.match(/activity\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // =========================
  // PARSER DO DELTA (OFSC)
  // =========================
  function deepScanOFSC(obj) {
    if (!obj) return;

    // Se vier delta.Activity (sync)
    if (obj.delta && obj.delta.Activity) {
      state.lastSyncAt = Date.now();

      for (const aid in obj.delta.Activity) {
        const data = obj.delta.Activity[aid] || {};
        const idNum = parseInt(aid, 10);
        if (!Number.isFinite(idNum)) continue;

        // NEW: guarda AID visto (mesmo que venha sem telefone)
        state.seenAids.add(String(idNum));

        const ctx = {
          aid: idNum,
          contrato: data.customer_number ? String(data.customer_number) : null,
          nome: data.cname || "Cliente",
          endereco: data.caddress || "Endereço não informado",
          horario: (data.service_window_start && data.service_window_end)
            ? `${data.service_window_start} - ${data.service_window_end}`
            : "",
          tecnico: getTechName() || data.auto_routed_to_provider_name || "Técnico não identificado",
          contatos: new Set(),
          observacao: "",
          tipoOS: data[544] || data.aworktype || data.atype || "Não identificado"
        };

        [data.cphone, data.ccell, data.phone].forEach(p => {
          const num = formatPhone(p);
          if (num) ctx.contatos.add(num);
        });

        // Observações/campos extra
        [236, 237, 238, 155, 187, 369, 699].forEach(k => {
          if (data[k]) {
            const txt = String(data[k]).replace(/\r\n|\n/g, " ").trim();
            if (txt) ctx.observacao += (ctx.observacao ? " | " : "") + txt;
          }
        });

        state.byAid.set(idNum, ctx);
        if (ctx.contrato) state.byContract.set(ctx.contrato, ctx);

        // ✅ SYNC COM BOT: envia para bridge local quando captura telefone
        if (ctx.contatos.size > 0) {
          syncCtxComBot(ctx);
        }
      }

      render();
      return;
    }

    // varredura profunda fallback
    if (typeof obj === "object") {
      Object.keys(obj).forEach(key => {
        if (typeof obj[key] === "object") deepScanOFSC(obj[key]);
      });
    }
  }

  // =========================
  // BOTÕES EXISTENTES
  // =========================
  window.copyVisitReport = function (e) {
    const btn = e ? e.target : null;
    const equip = getEquipmentData();
    const dataAtiv = getElementByText("Data");
    const contrato = getElementByText("Contrato") || state.currentContract || "";
    const nomeCli = getElementByText("Nome");
    const tecnico = getTechName();
    const complemento = getComplemento();

    const report = `Data: ${dataAtiv}
Contrato: ${contrato}
Nome do cliente: ${nomeCli}
Complemento: ${complemento}
Modelo equipamento: ${equip.modelo}
Numero serial: ${equip.serial}
Nome do Técnico: ${tecnico}`;

    navigator.clipboard.writeText(report).then(() => {
      if (btn) {
        const originalText = btn.innerText;
        btn.innerText = "✓ COPIADO!";
        btn.style.background = "#28a745";
        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.background = "#0056b3";
        }, 2000);
      }
      console.log("✅ Relatório copiado:", report);
    }).catch(err => console.error(err));
  };

  window.copyFormattedInfo = function (e) {
    const btn = e ? e.target : null;
    const ctx = state.byContract.get(state.currentContract) || state.byAid.get(state.currentAid);
    if (!ctx) {
      console.warn("Sem ctx ainda…");
      return;
    }

    const telefones = Array.from(ctx.contatos);
    const telefonesTexto = telefones.length > 0 ? telefones.join(" / ") : "";

    const texto = `DX 22 *FTZ*
‼ *RETIDO, 10/02* ‼
*Contrato*: ${ctx.contrato || ""}
*agenda*: ${ctx.horario || ""}
*Nome*: ${ctx.nome || ""}
*Endereço*: ${ctx.endereco || ""}
*Telefone*: ${telefonesTexto}
*END RET*: 
*TECNICO*: ${ctx.tecnico || ""}`;

    navigator.clipboard.writeText(texto).then(() => {
      if (btn) {
        const original = btn.innerText;
        btn.innerText = "✓ Copiado!";
        btn.style.background = "#28a745";
        setTimeout(() => {
          btn.innerText = original;
          btn.style.background = "#d81b60";
        }, 1800);
      }
      console.log("✅ Copiado:", texto);
    }).catch(err => {
      console.error("Erro ao copiar:", err);
    });
  };

  window.copyFullReport = function (e, contractKey) {
    const btn = e ? e.target : null;
    const ctx = state.byContract.get(contractKey) || state.byAid.get(state.currentAid);
    if (!ctx) return;

    const comp = getComplemento();
    const enderecoCompleto = ctx.endereco + (comp ? " " + comp : "");
    const listaTelefones = Array.from(ctx.contatos).map(n => "TEL: " + n).join("\n");

    const textoFinal = "⭕ FORA ROTA ⭕\n\n" +
      "CONTRATO: " + (ctx.contrato || "") + "\n" +
      "NOME: " + (ctx.nome || "") + "\n" +
      "END: " + enderecoCompleto + "\n" +
      "AGENDA: " + (ctx.horario || "Não informado") + "\n" +
      listaTelefones;

    navigator.clipboard.writeText(textoFinal).then(() => {
      if (btn) {
        btn.innerText = "Copiado!";
        setTimeout(() => { btn.innerText = "Copiar Tudo"; }, 2000);
      }
      console.log("✅ Copiado Tudo:", textoFinal);
    });
  };

  // =========================
  // TEMPLATE CAPTURE (quando vier telefone)
  // =========================
  function extractFormData(fd) {
    const out = [];
    try { for (const [k, v] of fd.entries()) out.push([k, v]); } catch { }
    return out;
  }

  function looksLikeHasPhones(delta) {
    if (!delta?.Activity) return false;
    const acts = delta.Activity;
    for (const aid of Object.keys(acts)) {
      const a = acts[aid] || {};
      if (a.cphone || a.ccell || a.phone) return true;
    }
    return false;
  }

  function captureTemplateFromXHR(method, url, body, json) {
    if (!json?.delta) return;
    if (!looksLikeHasPhones(json.delta)) return;
    if (!(body instanceof FormData)) return;

    state.template = {
      method: method || "POST",
      url: url,
      entries: extractFormData(body),
      sampleDeltaKeys: Object.keys(json.delta || {}),
    };
    state.lastTemplateAt = new Date().toISOString();

    state.exportStatus = "✅ Template capturado (agora dá pra exportar em lote)";
    console.log("✅ TEMPLATE CAPTURADO!", {
      url: state.template.url,
      keys: state.template.sampleDeltaKeys
    });
    render();
  }

  // =========================
  // COLETA AIDs (DOM + CACHE)
  // =========================
  function collectAidsFromDOM() {
    const aids = new Set();

    // links aid= / activity/
    document.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/aid=(\d+)/) || href.match(/activity\/(\d+)/);
      if (m && m[1]) aids.add(m[1]);
    });

    // data-*
    document.querySelectorAll("[data-aid],[data-activity-id],[data-activity],[data-id]").forEach(el => {
      const cand =
        el.getAttribute("data-aid") ||
        el.getAttribute("data-activity-id") ||
        el.getAttribute("data-activity") ||
        el.getAttribute("data-id");
      if (cand && /^\d+$/.test(cand)) aids.add(cand);
    });

    // fallback texto (IDs 8-12)
    document.querySelectorAll("td,span,div").forEach(el => {
      const t = (el.textContent || "").trim();
      if (/^\d{8,12}$/.test(t)) aids.add(t);
    });

    return Array.from(aids)
      .map(x => String(x))
      .filter(x => /^\d{8,12}$/.test(x))
      .sort((a, b) => Number(a) - Number(b));
  }

  function collectAidsFromCache() {
    // NEW: usa AIDs vistos no sync/cache
    return Array.from(state.seenAids)
      .map(x => String(x))
      .filter(x => /^\d{8,12}$/.test(x))
      .sort((a, b) => Number(a) - Number(b));
  }

  function collectAidsSmart() {
    const fromDom = collectAidsFromDOM();
    if (fromDom.length) return fromDom;

    const fromCache = collectAidsFromCache();
    return fromCache;
  }

  // =========================
  // REPLAY EM LOTE (puxa telefone sem abrir OS)
  // =========================
  async function postWithTemplateForAid(aid) {
    const tpl = state.template;
    if (!tpl?.entries?.length) throw new Error("Sem template");

    const absUrl = tpl.url.startsWith("http")
      ? tpl.url
      : (location.origin + (tpl.url.startsWith("?") ? "/" + tpl.url : tpl.url));

    const fd = new FormData();

    // replica template e sobrescreve os campos que carregam AID
    for (const [k, v] of tpl.entries) {
      let nv = v;

      if (k === "requestedAid") nv = String(aid);
      if (k === "aids") nv = JSON.stringify([String(aid)]);
      if (k === "queue[0][aId]") nv = String(aid);

      // “heurística”: se o campo tinha um aid no template, troca pelo novo
      if (k.toLowerCase().includes("aid") && /^\d{8,12}$/.test(String(v))) {
        nv = String(aid);
      }
      if (k.toLowerCase().includes("activity") && /^\d{8,12}$/.test(String(v))) {
        nv = String(aid);
      }

      fd.append(k, nv);
    }

    const r = await fetch(absUrl, {
      method: tpl.method || "POST",
      body: fd,
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });

    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { }

    if (!j?.delta) {
      return { aid, ok: false, status: r.status, error: "Sem delta (pode ter bloqueio/limite)", rawLen: text.length };
    }

    // alimenta parser
    deepScanOFSC(j);

    const ctx = state.byAid.get(parseInt(aid, 10));
    const telefones = ctx ? Array.from(ctx.contatos) : [];
    return {
      aid,
      ok: telefones.length > 0,
      status: r.status,
      contrato: ctx?.contrato || "",
      telefones
    };
  }

  window.tnExportContatosLote = async function () {
    if (state.exporting) return;

    if (!state.template) {
      state.exportStatus = "⚠ Sem template. Abra 1 OS pra capturar o request com telefones (uma vez).";
      render();
      return;
    }

    let aids = collectAidsSmart();

    if (!aids.length) {
      state.exportStatus = "⚠ Não achei AIDs nem no DOM nem no cache. Deixe a tela carregar (sync) ou abra 1 OS pra popular o cache.";
      render();
      return;
    }

    state.exporting = true;
    state.exportStatus = `⏳ Exportando ${aids.length} AIDs… (pode demorar)`;
    render();

    const results = [];
    const throttleMs = 250;

    for (let i = 0; i < aids.length; i++) {
      const aid = aids[i];
      state.exportStatus = `⏳ ${i + 1}/${aids.length}… aid=${aid}`;
      render();

      try {
        const res = await postWithTemplateForAid(aid);
        results.push(res);
      } catch (e) {
        results.push({ aid, ok: false, status: 0, error: String(e?.message || e) });
      }

      await sleep(throttleMs);
    }

    // monta export final "CONTRATO: TEL1 / TEL2"
    const final = [];
    for (const r of results) {
      if (!r.ok) continue;
      const contrato = r.contrato || "";
      const tels = (r.telefones || []).join(" / ");
      if (contrato && tels) final.push({ contrato, telefones: tels });
    }

    state.lastExport = final;
    window.__TN_EXPORT_CONTATOS__ = final;

    const txt = final.map(x => `${x.contrato}: ${x.telefones}`).join("\n");
    try { await navigator.clipboard.writeText(txt); } catch { }

    // ✅ SYNC COM BOT: envia todos os contratos exportados para o bridge
    if (final.length > 0) {
      const entriesBot = final.map(x => ({
        contrato: String(x.contrato).replace(/\D/g, ''),
        telefones: String(x.telefones).split('/').map(t => t.trim()).filter(t => t.length >= 10),
      }));
      try {
        const resp = await fetch(`http://${BOT_BRIDGE_HOST}:${BOT_BRIDGE_PORT}/toa/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'toa-extension-export', entries: entriesBot }),
        });
        const data = await resp.json();
        state.exportStatus = `✅ Export pronto: ${final.length} contratos. Bridge: ${data.inserted} sincronizados.`;
      } catch (err) {
        console.warn('[TOA-SYNC] Export batch falhou:', err.message);
        state.exportStatus = `✅ Export pronto: ${final.length} contratos (bridge offline: ${err.message})`;
      }
    } else {
      state.exportStatus = `✅ Export pronto: ${final.length} contratos com telefone. (Copiado pro clipboard)`;
    }

    console.log("✅ Export final em window.__TN_EXPORT_CONTATOS__", final);
    render();

    state.exporting = false;
  };

  // =========================
  // UI / Painel
  // =========================
  let isDragging = false;
  let offset = { x: 0, y: 0 };

  function onMouseDown(e) {
    const panel = document.getElementById("tn-panel");
    if (e.target.closest(".tn-header")) {
      isDragging = true;
      offset.x = e.clientX - panel.offsetLeft;
      offset.y = e.clientY - panel.offsetTop;
      panel.style.transition = "none";
    }
  }

  document.addEventListener("mousemove", function (e) {
    if (!isDragging) return;
    const panel = document.getElementById("tn-panel");
    if (panel) {
      state.pos.x = (e.clientX - offset.x);
      state.pos.y = (e.clientY - offset.y);
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = state.pos.x + "px";
      panel.style.top = state.pos.y + "px";
    }
  });

  document.addEventListener("mouseup", function () { isDragging = false; });

  window.tnToggleMin = function () { state.minimized = !state.minimized; render(); };
  window.tnClose = function () { const p = document.getElementById("tn-panel"); if (p) p.remove(); };

  function render() {
    if (!document.body || window.innerHeight < 150) return;

    state.currentAid = getActiveAidFromUrl();
    state.currentContract = getContractFromScreen();

    let panel = document.getElementById("tn-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "tn-panel";
      panel.addEventListener("mousedown", onMouseDown);
      document.body.appendChild(panel);
    }

    const posStyle = (state.pos.x !== null)
      ? `left:${state.pos.x}px; top:${state.pos.y}px; right:auto; bottom:auto;`
      : "right:10px; bottom:10px;";

    panel.style.cssText =
      "position:fixed; z-index:9999999; width:" + (state.minimized ? "180px" : "300px") + ";" +
      "background:#ffffff; color:#333; border-radius:8px; padding:0;" +
      "box-shadow:0 4px 20px rgba(0,0,0,0.15); font-family:sans-serif;" +
      "border:1px solid #ddd; overflow:hidden; " + posStyle;

    const ctx = state.byContract.get(state.currentContract) || state.byAid.get(state.currentAid);

    if (ctx) {
      const domTecnico = getTechName();
      if (domTecnico && domTecnico !== "Técnico não identificado") ctx.tecnico = domTecnico;
    }

    const headerHtml =
      '<div class="tn-header" style="display:flex; justify-content:space-between; align-items:center; background:#1a1a1a; color:#fff; padding:6px 12px; cursor:move; user-select:none; border-bottom:2px solid #e60000;">' +
      '<span style="font-size:10px; font-weight:bold;">SISTEMA TECHNET</span>' +
      '<div style="display:flex; gap:12px;">' +
      '<button onclick="tnToggleMin()" style="background:none; border:0; color:#fff; cursor:pointer; font-size:14px;">' + (state.minimized ? "□" : "—") + "</button>" +
      '<button onclick="tnClose()" style="background:none; border:0; color:#ff4d4d; cursor:pointer; font-size:14px; font-weight:bold;">✕</button>' +
      "</div>" +
      "</div>";

    if (state.minimized) { panel.innerHTML = headerHtml; return; }

    let content = '<div style="padding:12px; background:#fff;">';

    content += '<button onclick="window.copyFormattedInfo(event)" style="width:100%; background:#d81b60; color:white; border:none; padding:10px; border-radius:5px; font-weight:bold; font-size:11px; cursor:pointer; margin-bottom:10px; box-shadow:0 2px 4px rgba(0,0,0,0.2);">📋 COPIAR INFO FORMATADA (RET/FTZ)</button>';

    content += '<button onclick="window.copyVisitReport(event)" style="width:100%; background:#0056b3; color:white; border:none; padding:10px; border-radius:5px; font-weight:bold; font-size:11px; cursor:pointer; margin-bottom:10px; box-shadow:0 2px 4px rgba(0,0,0,0.2);">📝 GERAR RELATÓRIO DE VISITA</button>';

    content += '<button onclick="syncTodosComBot()" style="width:100%; background:#1565c0; color:white; border:none; padding:10px; border-radius:5px; font-weight:bold; font-size:11px; cursor:pointer; margin-bottom:10px; box-shadow:0 2px 4px rgba(0,0,0,0.2);">🔄 SYNC COM BOT (enviar ao bridge)</button>';

    content += '<button onclick="window.tnExportContatosLote()" style="width:100%; background:#6a1b9a; color:white; border:none; padding:10px; border-radius:5px; font-weight:bold; font-size:11px; cursor:pointer; margin-bottom:10px; box-shadow:0 2px 4px rgba(0,0,0,0.2);">📤 EXPORTAR CONTATOS EM LOTE</button>';

    const aidsCount = state.seenAids.size;
    content += '<div style="font-size:10px; color:#444; background:#f7f7f7; border:1px solid #eee; padding:8px; border-radius:6px; margin-bottom:10px;">' +
      '<div style="font-weight:700; color:#111; margin-bottom:4px;">Status:</div>' +
      '<div>' + (state.exportStatus || "—") + "</div>" +
      `<div style="margin-top:6px;">AIDs no cache: <b>${aidsCount}</b></div>` +
      (state.template
        ? '<div style="margin-top:6px; color:#2e7d32; font-weight:700;">Template: OK</div>'
        : '<div style="margin-top:6px; color:#c62828; font-weight:700;">Template: NÃO (abra 1 OS)</div>') +
      "</div>";

    content += '<hr style="border:0; border-top:1px solid #eee; margin-bottom:10px;">';

    if (!ctx || ctx.contatos.size === 0) {
      content += '<div style="font-size:11px; text-align:center; color:#999; padding:5px;">Aguardando dados...</div>';
    } else {
      content +=
        '<div style="font-size:9px; color:#e60000; font-weight:bold; margin-bottom:2px;">CONTRATO: ' + (ctx.contrato || "") + "</div>" +
        '<div style="font-size:10px; color:#333; margin-bottom:10px; font-weight:600; text-transform:uppercase;">' + (ctx.nome || "") + "</div>";

      Array.from(ctx.contatos).forEach(function (num) {
        content +=
          '<div style="background:#f9f9f9; margin-bottom:6px; padding:8px; border-radius:4px; border:1px solid #eee;">' +
          '<div style="font-size:16px; font-weight:bold; color:#1a1a1a; text-align:center; margin-bottom:6px;">' + num + "</div>" +
          '<div style="display:flex; gap:4px;">' +
          '<button onclick="window.copyFullReport(event, \'' + (ctx.contrato || "") + '\')" style="flex:1; background:#333; border:0; color:#fff; padding:5px; border-radius:3px; cursor:pointer; font-size:10px;">Copiar Tudo</button>' +
          '<a href="https://wa.me/55' + num + '" target="_blank" style="flex:1; background:#25d366; border:0; color:#fff; padding:5px; border-radius:3px; text-decoration:none; text-align:center; font-size:10px; font-weight:bold;">WhatsApp</a>' +
          "</div>" +
          "</div>";
      });
    }

    content += "</div>";
    panel.innerHTML = headerHtml + content;
  }

  // =========================
  // HOOK DE REDE (pega delta + pega template)
  // =========================
  const origFetch = window.fetch;
  window.fetch = async function () {
    const r = await origFetch.apply(this, arguments);
    const clone = r.clone();

    // tenta alimentar parser com resposta JSON (se for JSON)
    clone.text().then(t => {
      if (!t || (!t.startsWith("{") && !t.startsWith("["))) return;
      try { deepScanOFSC(JSON.parse(t)); } catch { }
    }).catch(() => { });

    return r;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tn_method = method;
    this.__tn_url = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      let j = null;
      try { j = JSON.parse(this.responseText); } catch { }

      // sempre tenta alimentar o parser
      try { deepScanOFSC(j); } catch { }

      // tenta capturar template quando vier telefone
      try { captureTemplateFromXHR(this.__tn_method, this.__tn_url, body, j); } catch { }
    });

    return origSend.apply(this, arguments);
  };


  // =========================
  // AUTO-LOOKUP (pesquisa automática quando bot pede)
  // =========================
  // O bot adiciona endpoint GET /toa/lookup/:contrato no bridge.
  // A extensão faz polling a cada 3s, e quando achar um contrato pendente,
  // simula digitação humana no campo de busca do TOA e clica na primeira OS.

  const AUTO_LOOKUP_INTERVAL_MS = 3000;
  const AUTO_LOOKUP_TYPING_DELAY_MS = () => 80 + Math.random() * 120; // 80-200ms por tecla
  const AUTO_LOOKUP_PAUSE_BEFORE_CLICK_MS = () => 600 + Math.random() * 800; // 0.6-1.4s

  let _autoLookupActive = false;
  let _autoLookupLastContract = null;

  // Dispara eventos reais de teclado/input no campo (bypass Knockout.js)
  async function humanTypeInField(inputEl, text) {
    inputEl.focus();
    await sleep(200 + Math.random() * 200);

    // Limpa o campo de forma humana (Ctrl+A → Delete)
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await sleep(50);
    inputEl.value = '';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }));
    await sleep(100 + Math.random() * 100);

    // Digita caractere a caractere
    for (const char of text) {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      inputEl.value += char;

      // Dispara o evento que o Knockout.js escuta (textInput binding)
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));

      // Atualiza o Knockout observable (binding textInput:searchValue)
      try {
        // Método 1: ko.dataFor direto
        if (window.ko) {
          const vm = window.ko.dataFor(inputEl);
          if (vm && vm.searchValue && typeof vm.searchValue === 'function') {
            vm.searchValue(inputEl.value);
          }
        }
        // Método 2: dispara o evento nativo que o KO textInput binding escuta
        // O KO textInput escuta 'input', 'change' e 'keyup' com debounce
        inputEl.dispatchEvent(new Event('propertychange', { bubbles: true }));
      } catch(e) {}

      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(AUTO_LOOKUP_TYPING_DELAY_MS());
    }

    console.log('[AUTO-LOOKUP] digitou:', text);
  }

  // Abre o campo de busca global e retorna o input correto
  // Campo confirmado via DOM: input.search-bar-input (sem "icon"), type="search",
  // placeholder="Pesquisa em atividades ou peças"
  // Botão toggle: input.search-bar-input.icon.global-search-bar-input-button
  async function abrirCampoBusca() {
    // Seletor exato do campo de busca (índice 73 no DOM)
    const SEARCH_INPUT_SEL = 'input.search-bar-input:not(.icon):not(.global-search-bar-input-button)';
    const TOGGLE_BTN_SEL   = 'input.search-bar-input.icon, input.global-search-bar-input-button, ' +
                             '.search-bar-button, [class*="search-bar-toggle"]';

    // Checa se o campo já está visível/ativo (não tem display:none nem visibility:hidden no pai)
    function isFieldActive(el) {
      if (!el) return false;
      // offsetParent é null se display:none em qualquer ancestral
      // mas o TOA pode usar visibility:hidden — checamos os dois
      let node = el;
      while (node && node !== document.body) {
        const s = window.getComputedStyle(node);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      return true;
    }

    const inp = document.querySelector(SEARCH_INPUT_SEL);

    // Se já está ativo, usa direto
    if (inp && isFieldActive(inp)) return inp;

    // Senão, clica no botão de toggle para abrir
    const toggleBtn = document.querySelector(TOGGLE_BTN_SEL);
    if (toggleBtn) {
      console.log('[AUTO-LOOKUP] clicando no toggle de busca...');
      toggleBtn.click();
      await sleep(500 + Math.random() * 300);
    } else {
      // Fallback: tenta clicar em qualquer elemento que contenha a lupa no header
      const lupaEl = Array.from(document.querySelectorAll(
        'button, [role="button"], a, span, div'
      )).find(el => {
        const lbl = (el.getAttribute('aria-label') || el.title || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        return lbl.includes('pesquis') || lbl.includes('search') ||
               cls.includes('search-bar') || cls.includes('search-toggle');
      });
      if (lupaEl) {
        console.log('[AUTO-LOOKUP] fallback clique em:', lupaEl.tagName, lupaEl.className);
        lupaEl.click();
        await sleep(500 + Math.random() * 300);
      }
    }

    // Espera o campo ficar ativo (até 4s)
    for (let i = 0; i < 20; i++) {
      const el = document.querySelector(SEARCH_INPUT_SEL);
      if (el && isFieldActive(el)) return el;
      await sleep(200);
    }

    // Último recurso: retorna o campo mesmo que "oculto" — o focus() às vezes o ativa
    const el = document.querySelector(SEARCH_INPUT_SEL);
    if (el) {
      console.warn('[AUTO-LOOKUP] campo pode estar oculto, tentando mesmo assim...');
      return el;
    }

    return null;
  }

  // Aguarda a lista de resultados aparecer e clica na primeira OS do contrato
  // Estrutura confirmada no TOA: popup com seção "Contrato", lista de OS
  // Aguarda os resultados da busca e clica no primeiro.
  // Estrutura confirmada no DOM real do TOA:
  //   DIV.global-search-found-item  — cada resultado de OS
  async function clicarPrimeiraOS(contrato) {
    // Espera até 6s pelos resultados (30 x 200ms)
    for (let i = 0; i < 30; i++) {
      const items = Array.from(document.querySelectorAll('div.global-search-found-item'));
      if (items.length > 0) {
        await sleep(AUTO_LOOKUP_PAUSE_BEFORE_CLICK_MS());
        console.log('[AUTO-LOOKUP] encontrou', items.length, 'resultado(s) — clicando no primeiro...');
        console.log('[AUTO-LOOKUP] texto:', items[0].textContent.trim().slice(0, 80));
        items[0].click();
        return true;
      }
      await sleep(200);
    }
    console.warn('[AUTO-LOOKUP] nenhum resultado encontrado para:', contrato);
    return false;
  }


  async function checkPendingLookup() {
    try {
      const resp = await fetch(
        `http://${BOT_BRIDGE_HOST}:${BOT_BRIDGE_PORT}/toa/pending-lookup`,
        { signal: AbortSignal.timeout(2000) }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.contrato || null;
    } catch {
      return null;
    }
  }

  // Marca lookup como processado no bridge
  async function ackLookup(contrato) {
    try {
      await fetch(
        `http://${BOT_BRIDGE_HOST}:${BOT_BRIDGE_PORT}/toa/ack-lookup`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contrato }),
          signal: AbortSignal.timeout(2000),
        }
      );
    } catch {}
  }

  // Loop principal de auto-lookup
  async function autoLookupLoop() {
    if (_autoLookupActive) return;
    _autoLookupActive = true;

    try {
      const contrato = await checkPendingLookup();
      if (!contrato || contrato === _autoLookupLastContract) return;

      _autoLookupLastContract = contrato;
      console.log('[AUTO-LOOKUP] contrato pendente detectado:', contrato);

      // Notifica no painel
      state.exportStatus = `🔍 Auto-pesquisando contrato ${contrato}...`;
      render();

      // Abre o campo de busca
      const inputEl = await abrirCampoBusca();
      if (!inputEl) {
        console.warn('[AUTO-LOOKUP] campo de busca não encontrado');
        state.exportStatus = `⚠ Campo de busca não encontrado para ${contrato}`;
        render();
        await ackLookup(contrato); // libera para não ficar em loop
        return;
      }

      // Digita o contrato simulando humano
      await humanTypeInField(inputEl, String(contrato));

      // Aguarda e clica na primeira OS
      const clicou = await clicarPrimeiraOS(contrato);

      if (clicou) {
        state.exportStatus = `✅ Auto-pesquisa: abriu OS do contrato ${contrato}`;
        console.log('[AUTO-LOOKUP] ✅ OS aberta para contrato:', contrato);
        // O hook XHR/fetch já vai capturar os telefones e chamar syncCtxComBot automaticamente
      } else {
        state.exportStatus = `⚠ Auto-pesquisa: sem resultados para ${contrato}`;
      }

      render();
      await ackLookup(contrato);

    } catch (err) {
      console.error('[AUTO-LOOKUP] erro:', err.message);
    } finally {
      _autoLookupActive = false;
    }
  }

  // Inicia o polling de auto-lookup
  setInterval(autoLookupLoop, AUTO_LOOKUP_INTERVAL_MS);
  console.log('[AUTO-LOOKUP] polling iniciado (intervalo:', AUTO_LOOKUP_INTERVAL_MS, 'ms)');


  // =========================
  // LOOP / INIT
  // =========================
  setInterval(render, 1200);
  render();

  state.exportStatus = "Abra 1 OS pra capturar o template. Depois exporte em lote (usa AIDs do cache do sync).";
})();