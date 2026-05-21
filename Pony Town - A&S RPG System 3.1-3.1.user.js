// ==UserScript==
// @name         Pony Town - A&S RPG System 3.1
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Registro por ID de 3 dígitos, apodos, panel flotante editable, acciones RPG por estados y búsqueda de joyas con cargas.
// @author       ChatGPT
// @match        https://pony.town/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'AANDS_RPG_SYSTEM_v3_1';
  const SEARCH_MAX_CHARGES = 3;
  const SEARCH_RECHARGE_MS = 180000;

  const SELECTORS = {
    chatLog: '.chat-log',
    chatLine: '.chat-line',
    chatLineMessage: '.chat-line-message',
    authorName: 'span.chat-line-name-content',
    profileBox: 'pony-box#pony-box, pony-box',
    profileNameText: '.pony-box-name-text',
    profileStatus: '.pony-box-name-status',
    profileButtonsBox: '.pony-box-buttons-box',
    profileButtons: '.pony-box-buttons',
  };

  const STATUS = {
    ONLINE: 'online',
    LOOKING_CHAT: 'looking_chat',
    LOOKING_RP: 'looking_rp',
    AWAY: 'away',
    BUSY: 'busy',
    UNKNOWN: 'unknown',
  };

  const STATUS_META = {
    [STATUS.ONLINE]:       { label: 'Online', emoji: '💚', color: '#3ddc84' },
    [STATUS.LOOKING_CHAT]: { label: 'Looking for chat', emoji: '📘', color: '#4aa3ff' },
    [STATUS.LOOKING_RP]:   { label: 'Looking for roleplay', emoji: '🎭', color: '#c77dff' },
    [STATUS.AWAY]:         { label: 'Away', emoji: '🌙', color: '#f5c542' },
    [STATUS.BUSY]:         { label: 'Busy', emoji: '⛔', color: '#ff5d5d' },
    [STATUS.UNKNOWN]:      { label: 'Unknown', emoji: '❔', color: '#b5b5b5' },
    loading:               { label: 'Reading profile…', emoji: '⏳', color: '#8aa4ff' },
  };

  const ITEMS = {
    anzuelo:   { psCost: 15, aceroCost: 3, rocaCost: 0, esmeCost: 0, kind: 'weapon', maxDamage: 20 },
    daga:      { psCost: 20, aceroCost: 5, rocaCost: 2, esmeCost: 0, kind: 'weapon', maxDamage: 35 },
    lanza:     { psCost: 25, aceroCost: 5, rocaCost: 10, esmeCost: 0, kind: 'weapon', maxDamage: 40 },
    espada:    { psCost: 30, aceroCost: 15, rocaCost: 20, esmeCost: 0, kind: 'weapon', maxDamage: 55 },
    tridente:  { psCost: 50, aceroCost: 30, rocaCost: 30, esmeCost: 3, kind: 'weapon', maxDamage: 80 },

    alimento:  { psCost: 3, kind: 'food', hunger: 4 },
    sushi:     { psCost: 4, kind: 'food', hunger: 6 },
    ensalada:  { psCost: 2, kind: 'food', hunger: 3, hp: 5 },
    sashimi:   { psCost: 5, kind: 'food', hunger: 3, hp: 10 },
    carpaccio: { psCost: 7, kind: 'food', hunger: 5, hp: 11 },

    roca:      { psCost: 0, kind: 'material' },
    acero:     { psCost: 0, kind: 'material' },
    esmeralda: { psCost: 0, kind: 'material' },
  };

  const seenChatNodes = new WeakSet();
  const chatQueue = [];
  const sendQueue = [];
  const outgoingEchoGuards = new Map();
  const lastSearchWarnTime = {};

  let processingChatQueue = false;
  let sendingQueue = false;

  let selectedUserId = null;
  let panelVisible = true;
  let panelPos = { left: 18, top: 18 };

  let users = {};
  let aliasToId = {};
  let chatNameToId = {};

  const lastCommandTime = {};

  function now() { return Date.now(); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function normalizeName(str) {
    return String(str || '')
      .replace(/[\u200B\uFEFF]/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function cleanText(str) {
    return String(str || '')
      .replace(/[\u200B\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[:：]$/, '')
      .trim();
  }

  function escapeHTML(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function extractText(node, { ignoreImages = false } = {}) {
    if (!node) return '';
    let txt = '';
    node.childNodes.forEach(ch => {
      if (ch.nodeType === Node.TEXT_NODE) txt += ch.textContent;
      else if (ch.nodeType === Node.ELEMENT_NODE && ch.tagName === 'IMG') {
        if (!ignoreImages) txt += ch.alt || '';
      } else if (ch.nodeType === Node.ELEMENT_NODE) {
        txt += extractText(ch, { ignoreImages });
      }
    });
    return cleanText(txt.replace(/\s+/g, ' '));
  }

  function formatDuration(ms) {
    ms = Math.max(0, ms);
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min <= 0) return `${sec}s`;
    return `${min}m ${String(sec).padStart(2, '0')}s`;
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      users = parsed.users || {};
      aliasToId = parsed.aliasToId || {};
      chatNameToId = parsed.chatNameToId || {};
      panelPos = parsed.panelPos || panelPos;
      panelVisible = parsed.panelVisible ?? panelVisible;
    } catch (e) {
      console.warn('[A&S RPG] load error:', e);
    }
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        users,
        aliasToId,
        chatNameToId,
        panelPos,
        panelVisible,
      }));
    } catch (e) {
      console.warn('[A&S RPG] save error:', e);
    }
  }

  function ensureUserShape(user) {
    if (!user) return user;
    user.id = String(user.id || '');
    user.chatName = cleanText(user.chatName || '');
    user.displayName = cleanText(user.displayName || user.chatName || '');
    user.aliases = Array.isArray(user.aliases) ? user.aliases : [];
    user.hp = Number.isFinite(user.hp) ? user.hp : 100;
    user.maxHp = Number.isFinite(user.maxHp) ? user.maxHp : 100;
    user.hunger = Number.isFinite(user.hunger) ? user.hunger : 10;
    user.gems = Number.isFinite(user.gems) ? user.gems : 0;
    user.maxDamage = Number.isFinite(user.maxDamage) ? user.maxDamage : 10;
    user.inventory = Array.isArray(user.inventory) ? user.inventory : [];
    user.weapon = user.weapon || null;
    user.searchRechargeAt = Array.isArray(user.searchRechargeAt) ? user.searchRechargeAt : [];
    user.createdAt = user.createdAt || now();
    return user;
  }

  function pruneSearchRecharge(user) {
    if (!user) return;
    user.searchRechargeAt = (user.searchRechargeAt || []).filter(ts => ts > now());
  }

  function getSearchCharges(user) {
    pruneSearchRecharge(user);
    return Math.max(0, SEARCH_MAX_CHARGES - (user.searchRechargeAt?.length || 0));
  }

  function useSearchCharge(user) {
    pruneSearchRecharge(user);
    if (getSearchCharges(user) <= 0) return false;
    user.searchRechargeAt.push(now() + SEARCH_RECHARGE_MS);
    user.searchRechargeAt.sort((a, b) => a - b);
    return true;
  }

  function nextSearchReadyIn(user) {
    pruneSearchRecharge(user);
    if (!user.searchRechargeAt || user.searchRechargeAt.length === 0) return 0;
    return Math.max(0, user.searchRechargeAt[0] - now());
  }

  function rebuildIndexes() {
    aliasToId = {};
    chatNameToId = {};
    for (const [id, rawUser] of Object.entries(users)) {
      const user = ensureUserShape(rawUser);
      users[id] = user;
      if (user.chatName) chatNameToId[normalizeName(user.chatName)] = id;
      if (user.displayName) aliasToId[normalizeName(user.displayName)] = id;
      for (const a of (user.aliases || [])) {
        if (a) aliasToId[normalizeName(a)] = id;
      }
    }
  }

  function generateUniqueId() {
    const taken = new Set(Object.keys(users));
    for (let i = 0; i < 2000; i++) {
      const id = String(Math.floor(Math.random() * 900) + 100);
      if (!taken.has(id)) return id;
    }
    return String(Math.floor(Math.random() * 900) + 100);
  }

  function getUserById(id) {
    return users[String(id)] || null;
  }

  function getUserIdByRef(ref) {
    if (!ref) return null;
    const raw = cleanText(ref);
    const norm = normalizeName(raw);

    if (/^\d{3}$/.test(raw) && users[raw]) return raw;
    if (chatNameToId[norm]) return chatNameToId[norm];
    if (aliasToId[norm]) return aliasToId[norm];

    for (const [id, user] of Object.entries(users)) {
      if (normalizeName(user.id) === norm) return id;
      if (normalizeName(user.chatName) === norm) return id;
      if (normalizeName(user.displayName) === norm) return id;
      if ((user.aliases || []).some(a => normalizeName(a) === norm)) return id;
    }
    return null;
  }

  function getPublicName(id) {
    const user = getUserById(id);
    if (!user) return '';
    return user.aliases?.[0] || user.displayName || user.chatName || user.id;
  }

  function getLabelForUser(id) {
    return `[${getPublicName(id)}]`;
  }

  function getInfoLabelForUser(id) {
    const user = getUserById(id);
    if (!user) return `#${id}`;
    return `${getLabelForUser(id)} (#${user.id})`;
  }

  function registerOrUpdateUser(chatName, displayName) {
    const cleanChat = cleanText(chatName);
    const cleanDisplay = cleanText(displayName || chatName);
    const existingId = chatNameToId[normalizeName(cleanChat)] || null;

    if (existingId) {
      const user = ensureUserShape(users[existingId]);
      user.chatName = cleanChat;
      if (cleanDisplay) user.displayName = cleanDisplay;
      users[existingId] = user;
      rebuildIndexes();
      saveData();
      return { id: existingId, created: false };
    }

    const id = generateUniqueId();
    users[id] = ensureUserShape({
      id,
      chatName: cleanChat,
      displayName: cleanDisplay,
      aliases: [],
      hp: 100,
      maxHp: 100,
      hunger: 10,
      gems: 0,
      maxDamage: 10,
      inventory: [],
      weapon: null,
      searchRechargeAt: [],
      createdAt: now(),
    });

    rebuildIndexes();
    saveData();
    return { id, created: true };
  }

  function addAliasToUser(ref, alias) {
    const id = getUserIdByRef(ref);
    if (!id) return { ok: false, reason: 'Usuario no registrado.' };

    const cleanAlias = cleanText(alias);
    if (!cleanAlias) return { ok: false, reason: 'Alias vacío.' };
    if (/^\d{3}$/.test(cleanAlias)) return { ok: false, reason: 'El apodo no puede ser un número de 3 dígitos.' };

    const normAlias = normalizeName(cleanAlias);
    if (aliasToId[normAlias] && aliasToId[normAlias] !== id) {
      return { ok: false, reason: 'Ese apodo ya está en uso.' };
    }

    const user = ensureUserShape(users[id]);
    if (!user.aliases.includes(cleanAlias)) user.aliases.push(cleanAlias);
    users[id] = user;
    rebuildIndexes();
    saveData();
    return { ok: true, id };
  }

  function deleteUser(ref) {
    const id = getUserIdByRef(ref);
    if (!id) return { ok: false, reason: 'Usuario no encontrado.' };
    delete users[id];
    rebuildIndexes();
    if (selectedUserId === id) selectedUserId = null;
    saveData();
    refreshPanel();
    return { ok: true, id };
  }

  function listUsersSorted() {
    return Object.values(users)
      .map(ensureUserShape)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  function getInputAndButton() {
    const input = document.querySelector('.chat-textarea.chat-commons.hide-scrollbar');
    const btn = document.querySelector('ui-button[title="Send message (hold Shift to send without closing input)"] button');
    return { input, btn };
  }

  function simulateEnter(input) {
    const ev1 = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    const ev2 = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    input.dispatchEvent(ev1);
    input.dispatchEvent(ev2);
  }

  function sendText(text, cb) {
    const { input, btn } = getInputAndButton();
    if (!input) {
      setTimeout(() => cb && cb(), 120);
      return;
    }
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (btn) btn.click();
    else simulateEnter(input);
    setTimeout(() => cb && cb(), 150);
  }

  function splitLongMessage(text) {
    const out = [];
    let rest = String(text || '');
    while (rest.length > 299) {
      out.push(rest.slice(0, 299).trim());
      rest = rest.slice(299).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  function markOutgoing(text) {
    outgoingEchoGuards.set(cleanText(text), now() + 20000);
  }

  function isOutgoingEcho(text) {
    const clean = cleanText(text);
    if (clean.startsWith('✦A&S✦')) return true;
    const exp = outgoingEchoGuards.get(clean);
    return !!(exp && exp > now());
  }

  function queueSend(text, { whisperTo = null, displayName = null } = {}) {
    const parts = splitLongMessage(text);
    for (const part of parts) {
      sendQueue.push({ kind: whisperTo ? 'whisper' : 'public', text: part, whisperTo, displayName });
      markOutgoing(part);
    }
    processSendQueue();
  }

  async function processSendQueue() {
    if (sendingQueue) return;
    sendingQueue = true;

    while (sendQueue.length) {
      const job = sendQueue.shift();
      if (!job) continue;

      if (job.kind === 'whisper' && job.whisperTo) {
        await new Promise(resolve => performWhisperSequence(job.whisperTo, job.text, job.displayName || job.whisperTo, resolve));
      } else {
        await new Promise(resolve => sendText(job.text, resolve));
      }

      await sleep(80);
    }

    sendingQueue = false;
  }

  function enqueuePublic(text) {
    queueSend(text);
  }

  function enqueueWhisper(whisperName, message, displayName) {
    queueSend(message, { whisperTo: whisperName, displayName });
  }

  function clickChatBoxTypeByDisplayName(displayName) {
    if (!displayName) return false;
    const boxes = document.querySelectorAll('.chat-box-type');
    function stripEmojis(s) {
      if (!s) return s;
      return s.replace(/[\p{Emoji_Presentation}\p{Emoji}\u200D\uFE0F\u20E3]/gu, '').trim();
    }
    const normalizedTarget = normalizeName(displayName);
    const strippedTarget = normalizeName(stripEmojis(displayName));
    for (const box of boxes) {
      const nameSpan = box.querySelector('.chat-box-type-name');
      if (!nameSpan) continue;
      const txtRaw = nameSpan.textContent || '';
      const txt = txtRaw.replace(/[\u200B\uFEFF]/g, '').trim();
      const norm = normalizeName(txt);
      const normStripped = normalizeName(stripEmojis(txt));
      if (norm === normalizedTarget || normStripped === strippedTarget) {
        box.click();
        return true;
      }
    }
    return false;
  }

  function performWhisperSequence(whisperName, message, displayName, done) {
    const { input, btn } = getInputAndButton();
    if (!input) {
      sendText(`/w ${whisperName} ${message}`, () => {
        sendText('/say', () => done && done());
      });
      return;
    }

    input.value = `/w ${whisperName}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    simulateEnter(input);

    setTimeout(() => {
      input.value = message;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (btn) btn.click();
      else simulateEnter(input);

      setTimeout(() => {
        let clicked = false;
        if (displayName) clicked = clickChatBoxTypeByDisplayName(displayName);
        if (!clicked) {
          const stripped = (displayName || '').replace(/[\p{Emoji_Presentation}\p{Emoji}\u200D\uFE0F\u20E3]/gu, '').trim();
          if (stripped) clicked = clickChatBoxTypeByDisplayName(stripped);
        }
        if (!clicked) clicked = clickChatBoxTypeByDisplayName(whisperName);
        if (!clicked) {
          input.value = '/say';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          simulateEnter(input);
        }
        setTimeout(() => done && done(), 120);
      }, 220);
    }, 220);
  }

  function getProfileBox() {
    return document.querySelector(SELECTORS.profileBox);
  }

  function getProfileNameNode(box = getProfileBox()) {
    if (!box) return null;
    return box.querySelector(SELECTORS.profileNameText);
  }

  function getProfileName(box = getProfileBox()) {
    const nameNode = getProfileNameNode(box);
    if (!nameNode) return '';
    const title = nameNode.getAttribute('title');
    return cleanText(title || extractText(nameNode, { ignoreImages: true }));
  }

  function getVisibleStatusNode(box = getProfileBox()) {
    if (!box) return null;
    const nodes = [...box.querySelectorAll(SELECTORS.profileStatus)];
    if (!nodes.length) return null;

    return nodes.find(el => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0;
    }) || nodes[0];
  }

  function readStatusFromProfile(box = getProfileBox()) {
    const statusNode = getVisibleStatusNode(box);
    if (!statusNode) return STATUS.UNKNOWN;

    const cls = String(statusNode.className || '');
    const svg = statusNode.querySelector('svg');
    const dataIcon = svg ? String(svg.getAttribute('data-icon') || '') : '';
    const title = String(statusNode.getAttribute('title') || '');

    if (cls.includes('text-online') || dataIcon === 'circle') return STATUS.ONLINE;
    if (cls.includes('text-away') || dataIcon === 'moon') return STATUS.AWAY;
    if (cls.includes('text-busy') || dataIcon === 'do-not-enter') return STATUS.BUSY;

    if (cls.includes('text-looking')) {
      if (dataIcon === 'masks-theater') return STATUS.LOOKING_RP;
      if (dataIcon === 'comment-question') return STATUS.LOOKING_CHAT;
      if (/roleplay/i.test(title)) return STATUS.LOOKING_RP;
      return STATUS.LOOKING_CHAT;
    }

    if (/online/i.test(title)) return STATUS.ONLINE;
    if (/away/i.test(title)) return STATUS.AWAY;
    if (/busy/i.test(title)) return STATUS.BUSY;
    if (/roleplay/i.test(title)) return STATUS.LOOKING_RP;
    if (/chat/i.test(title) || /looking/i.test(title)) return STATUS.LOOKING_CHAT;

    return STATUS.UNKNOWN;
  }

  function clickExactNameSpan(span) {
    if (!span) return false;
    try { span.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    const rect = span.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + Math.max(2, rect.width / 2),
      clientY: rect.top + Math.max(2, rect.height / 2),
      buttons: 1,
    };
    try {
      span.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (e) {
      console.warn('[A&S RPG] click error', e);
      return false;
    }
  }

  async function waitForProfileOpen(authorNorm, timeout = 700) {
    const start = now();
    while (now() - start < timeout) {
      const current = normalizeName(getProfileName());
      if (current && current === authorNorm) return true;
      await sleep(35);
    }
    return false;
  }

  function injectProfileTools() {
    const box = getProfileBox();
    if (!box) return;

    const profileNameNode = getProfileNameNode(box);
    if (!profileNameNode) return;

    const profileName = getProfileName(box);
    const userId = getUserIdByRef(profileName);

    let badge = box.querySelector('.aands-profile-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'aands-profile-badge';
      badge.style.cssText = `
        display:inline-flex;
        align-items:center;
        margin-left:8px;
        padding:2px 8px;
        border-radius:999px;
        font-size:11px;
        font-weight:700;
        color:#fff;
        background:rgba(74,163,255,.75);
        vertical-align:middle;
        user-select:none;
      `;
      profileNameNode.appendChild(badge);
    }
    badge.textContent = userId ? `#${userId}` : 'No RP';

    const btnBox = box.querySelector(SELECTORS.profileButtonsBox) || box.querySelector(SELECTORS.profileButtons);
    if (!btnBox) return;

    let actions = box.querySelector('.aands-profile-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'aands-profile-actions';
      actions.style.cssText = `
        display:flex;
        gap:6px;
        flex-wrap:wrap;
        margin-top:6px;
        padding:0 2px;
      `;

      const makeBtn = (label, bg) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = `
          cursor:pointer;
          border:0;
          border-radius:8px;
          padding:4px 8px;
          font-size:11px;
          font-weight:700;
          color:#fff;
          background:${bg};
        `;
        return b;
      };

      const regBtn = makeBtn('Registrar', '#4aa3ff');
      const aliasBtn = makeBtn('Apodo', '#c77dff');

      regBtn.addEventListener('click', () => {
        const currentName = getProfileName();
        if (!currentName) return;
        const promptValue = prompt('Nombre RP para registrar:', currentName);
        if (promptValue === null) return;
        const displayName = cleanText(promptValue) || currentName;
        const result = registerOrUpdateUser(currentName, displayName);
        selectedUserId = result.id;
        refreshPanel();
        injectProfileTools();
        enqueueWhisper(currentName, result.created
          ? `Registrado como ${displayName} con ID #${result.id}.`
          : `Perfil actualizado: ${displayName} (#${result.id}).`, currentName);
      });

      aliasBtn.addEventListener('click', () => {
        const currentName = getProfileName();
        if (!currentName) return;
        const userId = getUserIdByRef(currentName);
        if (!userId) {
          enqueueWhisper(currentName, 'Primero registra este perfil.', currentName);
          return;
        }
        const alias = prompt(`Apodo para ${getPublicName(userId)}:`);
        if (alias === null) return;
        const res = addAliasToUser(userId, alias);
        if (!res.ok) {
          enqueueWhisper(currentName, res.reason || 'No se pudo agregar el apodo.', currentName);
          return;
        }
        refreshPanel();
        injectProfileTools();
        enqueueWhisper(currentName, `Apodo añadido a ${getPublicName(userId)}: ${alias}`, currentName);
      });

      actions.appendChild(regBtn);
      actions.appendChild(aliasBtn);
      btnBox.appendChild(actions);
    }
  }

  function createPanel() {
    let panel = document.getElementById('aands-rpg-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'aands-rpg-panel';
    panel.innerHTML = `
      <div class="aands-header">
        <div class="aands-title">A&S RPG</div>
        <div class="aands-head-buttons">
          <button class="aands-btn" data-action="toggle">Hide</button>
          <button class="aands-btn" data-action="refresh">Refresh</button>
        </div>
      </div>
      <div class="aands-subtitle" id="aands-panel-subtitle">Registered users</div>
      <div class="aands-list" id="aands-user-list"></div>
      <div class="aands-editor">
        <div class="aands-editor-title">Selected user</div>
        <div class="aands-editor-grid">
          <label>Nombre <input id="aands-ed-name" type="text" /></label>
          <label>HP <input id="aands-ed-hp" type="number" /></label>
          <label>Hambre <input id="aands-ed-hunger" type="number" /></label>
          <label>Joyas <input id="aands-ed-gems" type="number" step="0.1" /></label>
          <label>Daño máx. <input id="aands-ed-dmg" type="number" /></label>
          <label>Apodo <input id="aands-ed-alias" type="text" /></label>
        </div>
        <div class="aands-editor-buttons">
          <button class="aands-btn aands-primary" data-action="save">Save</button>
          <button class="aands-btn" data-action="add-alias">Add alias</button>
          <button class="aands-btn aands-danger" data-action="delete">Delete</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #aands-rpg-panel{
        position:fixed;
        z-index:999999;
        width:360px;
        max-width:calc(100vw - 24px);
        max-height:calc(100vh - 24px);
        overflow:hidden;
        left:${panelPos.left}px;
        top:${panelPos.top}px;
        border-radius:18px;
        background:rgba(14,16,24,.93);
        color:#f3f5fb;
        box-shadow:0 20px 60px rgba(0,0,0,.35);
        border:1px solid rgba(255,255,255,.10);
        backdrop-filter: blur(12px);
        font:13px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      #aands-rpg-panel *{ box-sizing:border-box; }
      #aands-rpg-panel.hidden .aands-list,
      #aands-rpg-panel.hidden .aands-editor,
      #aands-rpg-panel.hidden #aands-panel-subtitle{ display:none; }
      #aands-rpg-panel .aands-header{
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:10px;
        padding:12px 12px 10px;
        cursor:move;
        user-select:none;
      }
      #aands-rpg-panel .aands-title{
        font-size:15px;
        font-weight:800;
        letter-spacing:.3px;
      }
      #aands-rpg-panel .aands-head-buttons,
      #aands-rpg-panel .aands-editor-buttons{
        display:flex;
        gap:6px;
        flex-wrap:wrap;
      }
      #aands-rpg-panel .aands-subtitle{
        padding:0 12px 8px;
        opacity:.75;
        font-size:12px;
      }
      #aands-rpg-panel .aands-list{
        max-height:230px;
        overflow:auto;
        padding:0 12px 10px;
      }
      #aands-rpg-panel .aands-row{
        display:grid;
        grid-template-columns: 58px 1fr 54px;
        gap:8px;
        align-items:center;
        padding:8px 10px;
        margin-bottom:6px;
        border-radius:12px;
        background:rgba(255,255,255,.05);
        border:1px solid rgba(255,255,255,.06);
        cursor:pointer;
      }
      #aands-rpg-panel .aands-row:hover{ background:rgba(255,255,255,.08); }
      #aands-rpg-panel .aands-row.selected{
        outline:1px solid rgba(74,163,255,.75);
        background:rgba(74,163,255,.16);
      }
      #aands-rpg-panel .aands-id{
        font-weight:800;
        color:#8fd3ff;
      }
      #aands-rpg-panel .aands-main{
        display:flex;
        flex-direction:column;
        gap:2px;
        min-width:0;
      }
      #aands-rpg-panel .aands-name{
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        font-weight:700;
      }
      #aands-rpg-panel .aands-mini{
        font-size:11px;
        opacity:.72;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      #aands-rpg-panel .aands-stats{
        text-align:right;
        font-size:11px;
        opacity:.88;
      }
      #aands-rpg-panel .aands-editor{
        border-top:1px solid rgba(255,255,255,.08);
        padding:10px 12px 12px;
      }
      #aands-rpg-panel .aands-editor-title{
        font-weight:800;
        margin-bottom:8px;
      }
      #aands-rpg-panel .aands-editor-grid{
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:8px;
      }
      #aands-rpg-panel label{
        display:flex;
        flex-direction:column;
        gap:4px;
        font-size:11px;
        opacity:.9;
      }
      #aands-rpg-panel input{
        width:100%;
        border:1px solid rgba(255,255,255,.12);
        background:rgba(255,255,255,.06);
        color:#fff;
        border-radius:10px;
        padding:7px 8px;
        outline:none;
      }
      #aands-rpg-panel input:focus{ border-color: rgba(74,163,255,.9); }
      #aands-rpg-panel .aands-editor-buttons{
        margin-top:10px;
      }
      #aands-rpg-panel .aands-btn{
        border:0;
        border-radius:10px;
        padding:7px 10px;
        background:rgba(255,255,255,.10);
        color:#fff;
        cursor:pointer;
        font-weight:700;
      }
      #aands-rpg-panel .aands-btn:hover{ background:rgba(255,255,255,.16); }
      #aands-rpg-panel .aands-primary{ background:rgba(74,163,255,.82); }
      #aands-rpg-panel .aands-primary:hover{ background:rgba(74,163,255,.96); }
      #aands-rpg-panel .aands-danger{ background:rgba(255,93,93,.80); }
      #aands-rpg-panel .aands-danger:hover{ background:rgba(255,93,93,.96); }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);

    const header = panel.querySelector('.aands-header');
    const btnToggle = panel.querySelector('[data-action="toggle"]');
    const btnRefresh = panel.querySelector('[data-action="refresh"]');
    const btnSave = panel.querySelector('[data-action="save"]');
    const btnAddAlias = panel.querySelector('[data-action="add-alias"]');
    const btnDelete = panel.querySelector('[data-action="delete"]');

    btnToggle.addEventListener('click', () => {
      panelVisible = !panelVisible;
      panel.classList.toggle('hidden', !panelVisible);
      btnToggle.textContent = panelVisible ? 'Hide' : 'Show';
      saveData();
    });

    btnRefresh.addEventListener('click', refreshPanel);

    btnSave.addEventListener('click', () => {
      if (!selectedUserId) return;
      const user = getUserById(selectedUserId);
      if (!user) return;

      const name = cleanText(panel.querySelector('#aands-ed-name').value);
      const hp = Number(panel.querySelector('#aands-ed-hp').value);
      const hunger = Number(panel.querySelector('#aands-ed-hunger').value);
      const gems = Number(panel.querySelector('#aands-ed-gems').value);
      const dmg = Number(panel.querySelector('#aands-ed-dmg').value);

      if (name) user.displayName = name;
      if (Number.isFinite(hp)) user.hp = hp;
      if (Number.isFinite(hunger)) user.hunger = hunger;
      if (Number.isFinite(gems)) user.gems = gems;
      if (Number.isFinite(dmg)) user.maxDamage = dmg;

      users[selectedUserId] = ensureUserShape(user);
      rebuildIndexes();
      saveData();
      refreshPanel();
      injectProfileTools();
      enqueuePublic(`✦A&S✦ Usuario ${getInfoLabelForUser(selectedUserId)} actualizado desde el panel.`);
    });

    btnAddAlias.addEventListener('click', () => {
      if (!selectedUserId) return;
      const alias = cleanText(panel.querySelector('#aands-ed-alias').value);
      const res = addAliasToUser(selectedUserId, alias);
      if (!res.ok) return;
      refreshPanel();
      injectProfileTools();
      enqueuePublic(`✦A&S✦ Apodo añadido a ${getInfoLabelForUser(selectedUserId)}: ${alias}`);
    });

    btnDelete.addEventListener('click', () => {
      if (!selectedUserId) return;
      const user = getUserById(selectedUserId);
      if (!user) return;
      if (!confirm(`Eliminar a ${getPublicName(selectedUserId)} (#${selectedUserId})?`)) return;
      deleteUser(selectedUserId);
      refreshPanel();
      injectProfileTools();
      enqueuePublic(`✦A&S✦ Usuario ${selectedUserId} eliminado.`);
    });

    let dragging = false;
    let dragOffset = { x: 0, y: 0 };

    header.addEventListener('pointerdown', ev => {
      if (ev.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffset.x = ev.clientX - rect.left;
      dragOffset.y = ev.clientY - rect.top;
      header.setPointerCapture?.(ev.pointerId);
    });

    window.addEventListener('pointermove', ev => {
      if (!dragging) return;
      panelPos.left = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dragOffset.x));
      panelPos.top = Math.max(0, Math.min(window.innerHeight - 80, ev.clientY - dragOffset.y));
      panel.style.left = `${panelPos.left}px`;
      panel.style.top = `${panelPos.top}px`;
      saveData();
    });

    window.addEventListener('pointerup', () => { dragging = false; });

    if (!panelVisible) panel.classList.add('hidden');
    btnToggle.textContent = panelVisible ? 'Hide' : 'Show';
    return panel;
  }

  function fillEditor(id) {
    const user = getUserById(id);
    if (!user) return;
    const panel = document.getElementById('aands-rpg-panel');
    if (!panel) return;

    panel.querySelector('#aands-ed-name').value = user.displayName || '';
    panel.querySelector('#aands-ed-hp').value = user.hp;
    panel.querySelector('#aands-ed-hunger').value = user.hunger;
    panel.querySelector('#aands-ed-gems').value = user.gems;
    panel.querySelector('#aands-ed-dmg').value = user.maxDamage;
    panel.querySelector('#aands-ed-alias').value = '';
  }

  function clearEditor() {
    const panel = document.getElementById('aands-rpg-panel');
    if (!panel) return;
    panel.querySelector('#aands-ed-name').value = '';
    panel.querySelector('#aands-ed-hp').value = '';
    panel.querySelector('#aands-ed-hunger').value = '';
    panel.querySelector('#aands-ed-gems').value = '';
    panel.querySelector('#aands-ed-dmg').value = '';
    panel.querySelector('#aands-ed-alias').value = '';
  }

  function refreshPanel() {
    createPanel();
    const list = document.getElementById('aands-user-list');
    const subtitle = document.getElementById('aands-panel-subtitle');
    if (!list || !subtitle) return;

    const all = listUsersSorted();
    subtitle.textContent = `Registered users: ${all.length}`;

    list.innerHTML = '';
    for (const user of all) {
      const row = document.createElement('div');
      row.className = 'aands-row' + (selectedUserId === user.id ? ' selected' : '');
      row.dataset.id = user.id;
      row.innerHTML = `
        <div class="aands-id">#${user.id}</div>
        <div class="aands-main">
          <div class="aands-name">${escapeHTML(getPublicName(user.id))}</div>
          <div class="aands-mini">${escapeHTML(user.chatName)}${user.aliases.length ? ' · ' + escapeHTML(user.aliases.join(', ')) : ''}</div>
        </div>
        <div class="aands-stats">❤${user.hp}<br>🥪${user.hunger}<br>💎${user.gems}</div>
      `;
      row.addEventListener('click', () => {
        selectedUserId = user.id;
        refreshPanel();
        fillEditor(user.id);
      });
      list.appendChild(row);
    }

    if (selectedUserId && getUserById(selectedUserId)) fillEditor(selectedUserId);
    else clearEditor();
  }

  function findChatNameSpan(line) {
    return line.querySelector(SELECTORS.authorName);
  }

  function getChatAuthor(line) {
    const nameNode = line.querySelector(SELECTORS.authorName);
    if (!nameNode) return '';
    return cleanText(extractText(nameNode, { ignoreImages: true }));
  }

  function getChatMessage(line) {
    const msgEl = line.querySelector(SELECTORS.chatLineMessage);
    if (!msgEl) return '';
    return cleanText(extractText(msgEl));
  }

  function getMostLikelyTargetIds(text, excludeId = null) {
    const found = new Set();
    const raw = String(text || '');
    const normRaw = normalizeName(raw);

    for (const n of (raw.match(/\b\d{3}\b/g) || [])) {
      if (users[n] && n !== String(excludeId || '')) found.add(n);
    }

    for (const [id, user] of Object.entries(users)) {
      if (excludeId && String(id) === String(excludeId)) continue;
      const candidates = [user.chatName, user.displayName, ...(user.aliases || [])];
      for (const cand of candidates) {
        const c = normalizeName(cand);
        if (c && normRaw.includes(c)) {
          found.add(id);
          break;
        }
      }
    }

    return [...found];
  }

  function findSingleTarget(text, excludeId = null) {
    const ids = getMostLikelyTargetIds(text, excludeId);
    return ids.length === 1 ? ids[0] : null;
  }

  function findAmount(text, excludeId = null) {
    const nums = (String(text || '').match(/\b\d+(?:\.\d+)?\b/g) || []).map(Number);
    if (nums.length === 0) return null;
    if (excludeId) {
      const targetNum = Number(excludeId);
      for (const n of nums) {
        if (n !== targetNum) return n;
      }
      return null;
    }
    return nums[0];
  }

  function findMentionedItem(text) {
    for (const key of Object.keys(ITEMS)) {
      if (new RegExp(`\\b${key}\\b`, 'i').test(text)) return key;
    }
    return null;
  }

  function detectRollTo100(text) {
    const m = String(text || '').match(/🎲\s*Rolled[:\s]*([0-9]{1,3}(?:\.[0-9]+)?)\s*of\s*100/i) ||
              String(text || '').match(/Rolled[:\s]*([0-9]{1,3}(?:\.[0-9]+)?)\s*of\s*100/i);
    return m ? Number(m[1]) : null;
  }

  function getStatusAction(status) {
    switch (status) {
      case STATUS.BUSY: return 'attack';
      case STATUS.AWAY: return 'craft';
      case STATUS.LOOKING_RP: return 'exchange';
      case STATUS.ONLINE:
      case STATUS.LOOKING_CHAT:
      default:
        return 'narration';
    }
  }

  function formatInventory(items) {
    if (!items || items.length === 0) return 'vacío';
    const counts = {};
    for (const it of items) counts[it] = (counts[it] || 0) + 1;
    return Object.entries(counts).map(([k, c]) => c > 1 ? `${k} x${c}` : k).join(' || ');
  }

  function spendFromInventory(user, itemKey, count = 1) {
    if (!user || !itemKey) return false;
    const have = user.inventory.reduce((c, x) => c + (x === itemKey ? 1 : 0), 0);
    if (have < count) return false;
    for (let i = 0; i < count; i++) {
      const idx = user.inventory.indexOf(itemKey);
      if (idx !== -1) user.inventory.splice(idx, 1);
    }
    return true;
  }

  function giveItem(fromId, toId, itemKey, count = 1) {
    const from = getUserById(fromId);
    const to = getUserById(toId);
    if (!from || !to) return false;
    if (!spendFromInventory(from, itemKey, count)) return false;
    for (let i = 0; i < count; i++) to.inventory.push(itemKey);
    users[fromId] = ensureUserShape(from);
    users[toId] = ensureUserShape(to);
    rebuildIndexes();
    saveData();
    return true;
  }

  function craftItem(userId, itemKey) {
    const user = getUserById(userId);
    if (!user) return { ok: false, reason: 'Usuario no registrado.' };
    const item = ITEMS[itemKey];
    if (!item || item.kind === 'material') return { ok: false, reason: 'Objeto inválido.' };

    const costPs = item.psCost || 0;
    const costAcero = item.aceroCost || 0;
    const costRoca = item.rocaCost || 0;
    const costEsme = item.esmeCost || 0;

    if (user.hp < costPs) return { ok: false, reason: 'PS insuficientes.' };
    if ((user.inventory.filter(x => x === 'acero').length) < costAcero) return { ok: false, reason: 'Acero insuficiente.' };
    if ((user.inventory.filter(x => x === 'roca').length) < costRoca) return { ok: false, reason: 'Roca insuficiente.' };
    if ((user.inventory.filter(x => x === 'esmeralda').length) < costEsme) return { ok: false, reason: 'Esmeraldas insuficientes.' };

    user.hp -= costPs;
    for (let i = 0; i < costAcero; i++) spendFromInventory(user, 'acero', 1);
    for (let i = 0; i < costRoca; i++) spendFromInventory(user, 'roca', 1);
    for (let i = 0; i < costEsme; i++) spendFromInventory(user, 'esmeralda', 1);

    if (item.kind === 'weapon') {
      user.weapon = itemKey;
      user.maxDamage = item.maxDamage || user.maxDamage;
    }

    user.inventory.push(itemKey);
    users[userId] = ensureUserShape(user);
    rebuildIndexes();
    saveData();
    return { ok: true, user };
  }

  function useItemEffect(user, itemKey) {
    if (!user || !itemKey) return false;
    const item = ITEMS[itemKey];
    if (!item) return false;
    if (!spendFromInventory(user, itemKey, 1)) return false;

    if (item.kind === 'weapon') {
      user.weapon = itemKey;
      user.maxDamage = item.maxDamage || user.maxDamage;
      return true;
    }

    if (item.kind === 'food') {
      if (Number.isFinite(item.hunger)) user.hunger = Math.min(10, user.hunger + item.hunger);
      if (Number.isFinite(item.hp)) user.hp = Math.min(user.maxHp, user.hp + item.hp);
      return true;
    }

    return true;
  }

  function formatActionPrefix(prefix) {
    return `[${prefix}]`;
  }

  function attackUser(attackerId, targetId, amount = null) {
    const attacker = getUserById(attackerId);
    const target = getUserById(targetId);
    if (!attacker || !target) return;

    const damage = Math.max(1, Math.min(Number.isFinite(amount) ? Math.floor(amount) : attacker.maxDamage, attacker.maxDamage || 10));
    target.hp = Math.max(0, target.hp - damage);

    const hungerCost = Math.max(1, Math.floor(damage / 2));
    if (attacker.hunger > 0) attacker.hunger = Math.max(0, attacker.hunger - hungerCost);
    else attacker.hp = Math.max(0, attacker.hp - hungerCost);

    users[attackerId] = ensureUserShape(attacker);
    users[targetId] = ensureUserShape(target);
    rebuildIndexes();
    saveData();

    enqueuePublic(`${formatActionPrefix('🗡✦')} ${getLabelForUser(attackerId)} atacó a ${getLabelForUser(targetId)} y causó ${damage} PS.`);
    enqueuePublic(`${formatActionPrefix('🗡✦')} ${getLabelForUser(targetId)} — 【❤${target.hp}】 ⊹ 【🥪${target.hunger}】 ⊹ 【💎${target.gems}】`);
    enqueuePublic(`${formatActionPrefix('🗡✦')} ${getLabelForUser(attackerId)} — 【❤${attacker.hp}】 ⊹ 【🥪${attacker.hunger}】 ⊹ 【💎${attacker.gems}】`);
  }

  function createByAway(userId, itemKey) {
    const result = craftItem(userId, itemKey);
    if (!result.ok) return;
    const user = getUserById(userId);
    const item = ITEMS[itemKey];
    const costs = [];
    if ((item.psCost || 0) > 0) costs.push(`-${item.psCost} PS`);
    if ((item.aceroCost || 0) > 0) costs.push(`-${item.aceroCost} acero`);
    if ((item.rocaCost || 0) > 0) costs.push(`-${item.rocaCost} roca`);
    if ((item.esmeCost || 0) > 0) costs.push(`-${item.esmeCost} esmeralda`);
    enqueuePublic(`${formatActionPrefix('💫✦')} ${getLabelForUser(userId)} creó ${itemKey}${costs.length ? ` (${costs.join(', ')})` : ''}.`);
    enqueuePublic(`${formatActionPrefix('💫✦')} ${getLabelForUser(userId)} — 【❤${user.hp}】 ⊹ 【🥪${user.hunger}】 ⊹ 【💎${user.gems}】`);
  }

  function exchangeItemOrGems(userId, text) {
    const user = getUserById(userId);
    if (!user) return;

    const targetId = findSingleTarget(text, userId);
    const itemKey = findMentionedItem(text);
    const amount = findAmount(text, targetId ? Number(targetId) : null);

    if (itemKey && !targetId) {
      const used = useItemEffect(user, itemKey);
      if (!used) {
        enqueueWhisper(user.chatName, `No tienes ${itemKey}.`, user.chatName);
        return;
      }
      users[userId] = ensureUserShape(user);
      rebuildIndexes();
      saveData();
      enqueuePublic(`${formatActionPrefix('👏✦')} ${getLabelForUser(userId)} usó ${itemKey}.`);
      enqueuePublic(`${formatActionPrefix('👏✦')} ${getLabelForUser(userId)} — 【❤${user.hp}】 ⊹ 【🥪${user.hunger}】 ⊹ 【💎${user.gems}】`);
      return;
    }

    if (itemKey && targetId) {
      const count = (amount && amount > 0) ? Math.floor(amount) : 1;
      if (!giveItem(userId, targetId, itemKey, count)) {
        enqueueWhisper(user.chatName, `No tienes suficientes ${itemKey}.`, user.chatName);
        return;
      }
      enqueuePublic(`${formatActionPrefix('🎁✦')} ${getLabelForUser(userId)} dio ${count > 1 ? `${count} ` : ''}${itemKey} a ${getLabelForUser(targetId)}.`);
      enqueuePublic(`${formatActionPrefix('🎁✦')} ${getLabelForUser(targetId)} — 【❤${getUserById(targetId).hp}】 ⊹ 【🥪${getUserById(targetId).hunger}】 ⊹ 【💎${getUserById(targetId).gems}】`);
      return;
    }

    if (!itemKey && targetId && amount !== null) {
      const gain = Number(amount);
      if (!Number.isFinite(gain) || gain <= 0) return;
      const target = getUserById(targetId);
      user.gems = Number((user.gems - gain).toFixed(1));
      target.gems = Number((target.gems + gain).toFixed(1));
      users[userId] = ensureUserShape(user);
      users[targetId] = ensureUserShape(target);
      rebuildIndexes();
      saveData();
      enqueuePublic(`${formatActionPrefix('💎✦')} ${getLabelForUser(userId)} abonó ${gain} joyas a ${getLabelForUser(targetId)}.`);
      enqueuePublic(`${formatActionPrefix('💎✦')} ${getLabelForUser(userId)} — 【❤${user.hp}】 ⊹ 【🥪${user.hunger}】 ⊹ 【💎${user.gems}】`);
      enqueuePublic(`${formatActionPrefix('💎✦')} ${getLabelForUser(targetId)} — 【❤${target.hp}】 ⊹ 【🥪${target.hunger}】 ⊹ 【💎${target.gems}】`);
    }
  }

  function handleSearchGems(userId, text) {
    const roll = detectRollTo100(text);
    if (roll === null) return false;

    const user = getUserById(userId);
    if (!user) return false;

    const charges = getSearchCharges(user);
    if (charges <= 0) {
      const remaining = formatDuration(nextSearchReadyIn(user));
      const lastWarn = lastSearchWarnTime[userId] || 0;
      if (now() - lastWarn > 10000) {
        enqueueWhisper(user.chatName, `No puedes buscar más joyas por el momento. Te queda ${remaining} para recuperar una tirada.`, user.chatName);
        lastSearchWarnTime[userId] = now();
      }
      return true;
    }

    useSearchCharge(user);
    const gain = Number((roll / 10).toFixed(1));
    user.gems = Number((user.gems + gain).toFixed(1));

    users[userId] = ensureUserShape(user);
    rebuildIndexes();
    saveData();

    enqueuePublic(`${formatActionPrefix('💎✦')} ${getLabelForUser(userId)} buscó joyas y obtuvo ${gain} joyas.`);
    enqueuePublic(`${formatActionPrefix('💎✦')} ${getLabelForUser(userId)} — 【❤${user.hp}】 ⊹ 【🥪${user.hunger}】 ⊹ 【💎${user.gems}】`);
    return true;
  }

  function processCommand(authorId, authorName, text) {
    const raw = cleanText(text);
    if (!raw.startsWith('!')) return false;

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '!reg': {
        const rpName = cleanText(args.join(' ')) || authorName;
        const result = registerOrUpdateUser(authorName, rpName);
        selectedUserId = result.id;
        refreshPanel();
        injectProfileTools();
        enqueueWhisper(authorName, result.created
          ? `Registrado como ${rpName} con ID #${result.id}.`
          : `Perfil actualizado: ${rpName} (#${result.id}).`, authorName);
        return true;
      }

      case '!apodo': {
        if (args.length === 0) {
          enqueueWhisper(authorName, 'Uso: !apodo <digitos/nombre/apodo> <nuevo apodo>', authorName);
          return true;
        }
        let targetRef = authorName;
        let aliasParts = args;

        if (args.length >= 2) {
          const maybeTarget = getUserIdByRef(args[0]);
          if (maybeTarget) {
            targetRef = args[0];
            aliasParts = args.slice(1);
          }
        }

        const alias = cleanText(aliasParts.join(' '));
        const res = addAliasToUser(targetRef, alias);
        if (!res.ok) {
          enqueueWhisper(authorName, res.reason || 'No se pudo agregar el apodo.', authorName);
          return true;
        }
        selectedUserId = res.id;
        refreshPanel();
        injectProfileTools();
        enqueueWhisper(authorName, `Apodo añadido a ${getPublicName(res.id)}: ${alias}`, authorName);
        return true;
      }

      case '!del': {
        const ref = args.join(' ').trim() || authorName;
        const res = deleteUser(ref);
        if (!res.ok) {
          enqueueWhisper(authorName, res.reason || 'No se pudo eliminar.', authorName);
          return true;
        }
        enqueueWhisper(authorName, `Usuario eliminado.`, authorName);
        refreshPanel();
        injectProfileTools();
        return true;
      }

      case '!info': {
        const ref = args.join(' ').trim() || authorName;
        const id = getUserIdByRef(ref);
        if (!id) {
          enqueueWhisper(authorName, 'No registrado.', authorName);
          return true;
        }
        const u = getUserById(id);
        enqueueWhisper(authorName,
          `— ${getInfoLabelForUser(id)} — ❤${u.hp}/${u.maxHp} ⊹ 🥪${u.hunger} ⊹ 💎${u.gems.toFixed(1)} ⊹ 🔥${u.maxDamage} ⊹ Apodos: ${u.aliases.length ? u.aliases.join(', ') : '—'}`,
          authorName
        );
        return true;
      }

      case '!inventario':
      case '!inv': {
        const ref = args.join(' ').trim() || authorName;
        const id = getUserIdByRef(ref);
        if (!id) {
          enqueueWhisper(authorName, 'Usuario no registrado.', authorName);
          return true;
        }
        const u = getUserById(id);
        enqueueWhisper(authorName, `Inventario de ${getLabelForUser(id)}: ${formatInventory(u.inventory)}`, authorName);
        return true;
      }

      case '!usuarios': {
        const list = listUsersSorted();
        if (!list.length) {
          enqueueWhisper(authorName, 'No hay usuarios registrados.', authorName);
          return true;
        }
        const names = list.map(u => getPublicName(u.id)).join(' || ');
        enqueueWhisper(authorName, `Usuarios: ${names}`, authorName);
        return true;
      }

      case '!sethp':
      case '!sethambre':
      case '!setjoyas':
      case '!setdmg': {
        const ref = args[0] || authorName;
        const id = getUserIdByRef(ref);
        const val = Number(args[1]);
        if (!id || !Number.isFinite(val)) {
          enqueueWhisper(authorName, 'Uso inválido.', authorName);
          return true;
        }
        const u = ensureUserShape(getUserById(id));
        if (cmd === '!sethp') u.hp = val;
        if (cmd === '!sethambre') u.hunger = val;
        if (cmd === '!setjoyas') u.gems = Number(val.toFixed(1));
        if (cmd === '!setdmg') u.maxDamage = val;
        users[id] = u;
        rebuildIndexes();
        saveData();
        refreshPanel();
        enqueueWhisper(authorName, `Usuario actualizado: ${getPublicName(id)}.`, authorName);
        return true;
      }

      case '!addobj':
      case '!rmobj': {
        const ref = args[0] || authorName;
        const itemKey = normalizeName(args[1] || '');
        const count = Math.max(1, parseInt(args[2] || '1', 10) || 1);
        const id = getUserIdByRef(ref);
        const u = id ? getUserById(id) : null;
        if (!u || !ITEMS[itemKey]) {
          enqueueWhisper(authorName, 'Uso inválido.', authorName);
          return true;
        }
        if (cmd === '!addobj') {
          for (let i = 0; i < count; i++) u.inventory.push(itemKey);
        } else {
          spendFromInventory(u, itemKey, count);
        }
        users[id] = ensureUserShape(u);
        rebuildIndexes();
        saveData();
        refreshPanel();
        enqueueWhisper(authorName, `Inventario actualizado de ${getPublicName(id)}.`, authorName);
        return true;
      }

      default:
        return false;
    }
  }

  function handleActionByStatus(userId, text, status) {
    handleSearchGems(userId, text);

    const targetId = findSingleTarget(text, userId);
    const itemKey = findMentionedItem(text);
    const amount = findAmount(text, targetId ? Number(targetId) : null);

    const action = getStatusAction(status);

    if (action === 'attack') {
      if (!targetId) return;
      attackUser(userId, targetId, amount);
      return;
    }

    if (action === 'craft') {
      if (!itemKey) return;
      createByAway(userId, itemKey);
      return;
    }

    if (action === 'exchange') {
      if (itemKey || (targetId && amount !== null)) {
        exchangeItemOrGems(userId, text);
      }
      return;
    }
  }

  function getStatusFromCurrentProfile() {
    return readStatusFromProfile();
  }

  function clickProfileFromChatLine(line) {
    const span = findChatNameSpan(line);
    if (!span) return false;
    return clickExactNameSpan(span);
  }

  async function processChatQueue() {
    if (processingChatQueue) return;
    processingChatQueue = true;

    while (chatQueue.length) {
      const job = chatQueue.shift();
      if (!job) continue;
      if (isOutgoingEcho(job.text)) continue;

      const currentProfileNorm = normalizeName(getProfileName());
      if (currentProfileNorm !== job.authorNorm) {
        clickProfileFromChatLine(job.line);
        await sleep(100);
        await waitForProfileOpen(job.authorNorm, 650);
      }

      injectProfileTools();
      const status = getStatusFromCurrentProfile();
      const authorId = getUserIdByRef(job.author);
      if (!authorId) continue;

      if (processCommand(authorId, job.author, job.text)) {
        continue;
      }

      handleActionByStatus(authorId, job.text, status);
    }

    processingChatQueue = false;
  }

  function observeChat() {
    const chatLog = document.querySelector(SELECTORS.chatLog);
    if (!chatLog) {
      setTimeout(observeChat, 500);
      return;
    }

    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!node.classList.contains('chat-line')) continue;
          if (seenChatNodes.has(node)) continue;
          seenChatNodes.add(node);

          const msg = getChatMessage(node);
          if (!msg) continue;
          if (isOutgoingEcho(msg)) continue;

          const author = getChatAuthor(node);
          if (!author) continue;

          chatQueue.push({
            author,
            authorNorm: normalizeName(author),
            text: msg,
            line: node,
          });
        }
      }
      void processChatQueue();
    });

    obs.observe(chatLog, { childList: true, subtree: true });
  }

  function observeProfileOpen() {
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.(SELECTORS.profileBox) || node.querySelector?.(SELECTORS.profileBox)) {
            injectProfileTools();
            return;
          }
        }
      }
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  function initDrag() {
    const panel = document.getElementById('aands-rpg-panel');
    if (!panel) return;
    const header = panel.querySelector('.aands-header');
    if (!header) return;

    let dragging = false;
    let dragOffset = { x: 0, y: 0 };

    header.addEventListener('pointerdown', ev => {
      if (ev.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffset.x = ev.clientX - rect.left;
      dragOffset.y = ev.clientY - rect.top;
      header.setPointerCapture?.(ev.pointerId);
    });

    window.addEventListener('pointermove', ev => {
      if (!dragging) return;
      panelPos.left = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dragOffset.x));
      panelPos.top = Math.max(0, Math.min(window.innerHeight - 80, ev.clientY - dragOffset.y));
      panel.style.left = `${panelPos.left}px`;
      panel.style.top = `${panelPos.top}px`;
      saveData();
    });

    window.addEventListener('pointerup', () => { dragging = false; });
  }

  function init() {
    loadData();
    rebuildIndexes();
    createPanel();
    refreshPanel();
    initDrag();
    observeChat();
    observeProfileOpen();
  }

  window.addEventListener('load', () => setTimeout(init, 800));

})();