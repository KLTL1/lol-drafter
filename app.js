"use strict";

/* ================= Data Dragon icons ================= */
let DD_VER = DDRAGON_FALLBACK;
fetch("https://ddragon.leagueoflegends.com/api/versions.json")
  .then(r => r.json()).then(v => { if (v && v[0]) { DD_VER = v[0]; render(); } })
  .catch(() => {});

function champImgHTML(key, size) {
  const c = CHAMPIONS[key];
  if (!c) return `<div class="ph">?</div>`;
  const initials = dispName(key).slice(0, 2);
  return `<img src="https://ddragon.leagueoflegends.com/cdn/${DD_VER}/img/champion/${c.id}.png"
    alt="${dispName(key)}" loading="lazy"
    onerror="this.outerHTML='<div class=&quot;ph&quot;>${initials}</div>'">`;
}

function dispName(key) { return CHAMPIONS[key].name || key; }

/* ================= Name normalization =================
   Matchup/synergy lists use loose names ("Miss Fortune", "Kog'Maw",
   "TwistedFate"); resolve them all to champion keys. */
const NORM_MAP = {};
function norm(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); }
Object.keys(CHAMPIONS).forEach(k => {
  NORM_MAP[norm(k)] = k;
  NORM_MAP[norm(CHAMPIONS[k].id)] = k;
  if (CHAMPIONS[k].name) NORM_MAP[norm(CHAMPIONS[k].name)] = k;
});
function resolve(nameOrKey) { return NORM_MAP[norm(nameOrKey)] || null; }
function listHas(list, key) { return (list || []).some(n => resolve(n) === key); }

/* ================= Draft sequence ================= */
// Standard tournament draft relative to first-pick team A:
// Ban1 A B A B A B | Pick1 A BB AA B | Ban2 B A B A | Pick2 B AA B
function buildSequence(firstPick) {
  const A = firstPick, B = firstPick === "blue" ? "red" : "blue";
  const seq = [];
  [A, B, A, B, A, B].forEach(s => seq.push({ type: "ban", side: s, phase: 1 }));
  [A, B, B, A, A, B].forEach(s => seq.push({ type: "pick", side: s, phase: 1 }));
  [B, A, B, A].forEach(s => seq.push({ type: "ban", side: s, phase: 2 }));
  [B, A, A, B].forEach(s => seq.push({ type: "pick", side: s, phase: 2 }));
  // per-side slot numbering
  const count = { blue: { ban: 0, pick: 0 }, red: { ban: 0, pick: 0 } };
  seq.forEach(st => { st.slot = count[st.side][st.type]++; });
  return seq;
}

/* ================= State ================= */
const state = {
  mySide: "blue",
  firstPick: "blue",
  seq: buildSequence("blue"),
  actions: new Array(20).fill(null),     // champion key per sequence index
  roles: { blue: new Array(5).fill(null), red: new Array(5).fill(null) }, // role per pick slot
  editing: null,                          // sequence index being edited, or null
  fearless: new Set(),
  fearlessMode: false,
  search: "",
  gridRole: "all",
  recRole: "all",
  undoStack: [],
};

function snapshot() {
  return JSON.stringify({
    actions: state.actions, roles: state.roles,
    fearless: [...state.fearless],
  });
}
function pushUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 60) state.undoStack.shift();
}
function undo() {
  const s = state.undoStack.pop();
  if (!s) return;
  const o = JSON.parse(s);
  state.actions = o.actions; state.roles = o.roles; state.fearless = new Set(o.fearless);
  state.editing = null;
  render();
}

function currentIndex() {
  if (state.editing !== null) return state.editing;
  const i = state.actions.findIndex(a => a === null);
  return i; // -1 = draft complete
}

function usedChamps() {
  return new Set(state.actions.filter(Boolean));
}

function teamPicks(side) {
  const out = [];
  state.seq.forEach((st, i) => {
    if (st.type === "pick" && st.side === side && state.actions[i])
      out.push({ key: state.actions[i], slot: st.slot, role: state.roles[side][st.slot] });
  });
  return out;
}

/* ================= Role inference ================= */
function inferRole(side, champKey) {
  const taken = new Set(teamPicks(side).map(p => p.role).filter(Boolean));
  const open = ROLES.filter(r => !taken.has(r));
  const c = CHAMPIONS[champKey];
  let best = open[0] || ROLES[0], bestScore = -1;
  for (const r of open) {
    const rd = c.roles[r];
    const s = rd ? rd.pr + (rd.wr - 48) : (c.flex || []).includes(r) ? 1 : 0;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return best;
}

/* ================= Comp aggregation ================= */
function compStats(picks) {
  const s = { n: picks.length, ad: 0, ap: 0, front: 0, cc: 0, engage: 0, peel: 0, early: 0, late: 0, poke: 0, split: 0 };
  picks.forEach(p => {
    const c = CHAMPIONS[p.key];
    if (c.dmg === "ad") s.ad++; else if (c.dmg === "ap") s.ap++; else { s.ad += 0.5; s.ap += 0.5; }
    s.front += c.a.front; s.cc += c.a.cc; s.engage = Math.max(s.engage, c.a.engage);
    s.peel += c.a.peel; s.early += c.a.early; s.late += c.a.late;
    s.poke += c.a.poke; s.split += c.a.split;
  });
  return s;
}

/* ================= Scoring ================= */
const TIER_BONUS = { S: 1.5, A: 0.7, B: 0 };

function proScore(c) {
  let s = (c.pro.p || 0) * 0.12;
  if (c.pro.p >= 5) s += (c.pro.wr - 50) * 0.12;
  return s;
}
function soloScore(c, role) {
  const rd = c.roles[role];
  if (!rd) return -3; // off-meta role for this champ
  return (rd.wr - 50) * 0.7 + (TIER_BONUS[rd.tier] || 0) + Math.min(rd.pr, 12) * 0.06;
}

function scorePick(key, role, mySide, opts) {
  const c = CHAMPIONS[key];
  const enemySide = mySide === "blue" ? "red" : "blue";
  const allies = teamPicks(mySide);
  const enemies = teamPicks(enemySide);
  const reasons = [];
  let score = 0;

  // Pro priority (pro-style weighting: dominant term)
  const pr = proScore(c);
  score += pr;
  if (c.pro.p >= 40) reasons.push(["+", "top pro priority"]);
  else if (c.pro.p >= 15) reasons.push(["+", "pro-proven"]);

  // Solo queue strength in role
  const sq = soloScore(c, role) * 0.6;
  score += sq;
  const rd = c.roles[role];
  if (rd && rd.wr >= 51.5) reasons.push(["+", `${rd.wr}% WR solo queue`]);
  if (rd && rd.wr < 48.5) reasons.push(["-", `${rd.wr}% WR solo queue`]);
  if (!rd) reasons.push(["-", "off-meta in " + ROLE_LABEL[role]]);

  // 26.12 patch nudges
  if (META.patchBuffs.includes(key)) { score += 0.8; reasons.push(["+", "buffed in 26.12"]); }
  if (META.patchNerfs.includes(key)) { score -= 0.8; reasons.push(["-", "nerfed in 26.12"]); }

  // Matchups vs revealed enemies
  let laneKnown = false;
  enemies.forEach(e => {
    const ec = CHAMPIONS[e.key];
    const sameLane = e.role === role;
    if (sameLane) laneKnown = true;
    const w = sameLane ? 2.2 : 0.6;
    const badVs = listHas(c.counteredBy, e.key) || listHas(ec.beats, key);
    const goodVs = listHas(c.beats, e.key) || listHas(ec.counteredBy, key);
    if (badVs && !goodVs) { score -= w; reasons.push(["-", `countered by ${dispName(e.key)}`]); }
    if (goodVs && !badVs) { score += w; reasons.push(["+", `strong vs ${dispName(e.key)}`]); }
  });

  // Blind-pick risk: lane opponent unknown and champ is counterpick-only
  if (!laneKnown && c.blind === false && !opts.lastPick) {
    score -= 1.5; reasons.push(["-", "risky blind pick"]);
  }
  if (!laneKnown && c.blind === true && opts.earlyPick) {
    score += 0.6; reasons.push(["+", "safe blind"]);
  }

  // Flex value early in draft
  if (opts.earlyPick && (c.flex || []).length >= 2) {
    score += 1.3; reasons.push(["+", `flex (${c.flex.map(r => ROLE_LABEL[r]).join("/")})`]);
  }

  // Synergy with allies
  allies.forEach(a => {
    const ac = CHAMPIONS[a.key];
    if (listHas(c.syn, a.key) || listHas(ac.syn, key)) {
      score += 1.2; reasons.push(["+", `synergy: ${dispName(a.key)}`]);
    }
  });

  // Team comp needs (only meaningful once we have 2+ picks)
  const comp = compStats(allies);
  if (comp.n >= 2) {
    if (comp.ap === 0 && c.dmg === "ap") { score += 1.8; reasons.push(["+", "adds AP damage"]); }
    if (comp.ad === 0 && c.dmg === "ad") { score += 1.8; reasons.push(["+", "adds AD damage"]); }
    if (c.dmg === "mix" && (comp.ap < 1 || comp.ad < 1)) { score += 0.8; reasons.push(["+", "mixed damage"]); }
    if (comp.front < 3 && c.a.front >= 2) { score += 1.5; reasons.push(["+", "adds frontline"]); }
    if (comp.cc < 4 && c.a.cc >= 2) { score += 1.0; reasons.push(["+", "adds CC"]); }
    if (comp.engage < 2 && c.a.engage >= 2) { score += 1.2; reasons.push(["+", "adds engage"]); }
    if (comp.late >= 5 && comp.peel < 3 && c.a.peel >= 2) { score += 1.0; reasons.push(["+", "peel for carries"]); }
    // win-condition coherence
    const lean = comp.early - comp.late;
    if (lean >= 2 && c.a.early >= 2) { score += 0.6; reasons.push(["+", "fits early-game plan"]); }
    if (lean <= -2 && c.a.late >= 2) { score += 0.6; reasons.push(["+", "fits scaling plan"]); }
  }

  // Enemy comp counters
  const ecomp = compStats(enemies);
  if (ecomp.n >= 3) {
    if (ecomp.ap < 0.6 && c.a.front >= 2) { score += 0.6; reasons.push(["+", "enemy is full AD"]); }
    if (ecomp.ad < 0.6 && c.a.front >= 2) { score += 0.4; reasons.push(["+", "enemy is full AP"]); }
    if (ecomp.poke >= 5 && c.a.engage >= 2) { score += 0.8; reasons.push(["+", "engage vs poke comp"]); }
    if (ecomp.engage >= 3 && c.a.peel >= 2) { score += 0.6; reasons.push(["+", "disengage vs dive"]); }
  }

  return { score, reasons };
}

function scoreBan(key, mySide) {
  const c = CHAMPIONS[key];
  const enemySide = mySide === "blue" ? "red" : "blue";
  const myPicks = teamPicks(mySide);
  const reasons = [];
  let score = proScore(c);

  // best solo-queue role strength
  let bestSolo = -3;
  ROLES.forEach(r => { if (c.roles[r]) bestSolo = Math.max(bestSolo, soloScore(c, r)); });
  score += bestSolo * 0.45;

  if (META.firstPickBan.includes(key)) { score += 1.5; reasons.push(["+", "first pick/ban tier"]); }
  if (c.pro.p >= 40) reasons.push(["+", `${c.pro.p}% pro presence`]);
  if ((c.flex || []).length >= 2) { score += 0.7; reasons.push(["+", "flex threat"]); }
  if (META.patchBuffs.includes(key)) { score += 0.5; reasons.push(["+", "just buffed"]); }

  // Threat to our existing picks
  myPicks.forEach(p => {
    const pc = CHAMPIONS[p.key];
    if (listHas(c.beats, p.key) || listHas(pc.counteredBy, key)) {
      score += 1.6; reasons.push(["+", `counters your ${dispName(p.key)}`]);
    }
  });

  // Synergy with enemy's existing picks (they'd love to complete the combo)
  const enemies = teamPicks(enemySide);
  enemies.forEach(e => {
    const ec = CHAMPIONS[e.key];
    if (listHas(c.syn, e.key) || listHas(ec.syn, key)) {
      score += 0.9; reasons.push(["+", `combos with their ${dispName(e.key)}`]);
    }
  });

  return { score, reasons };
}

/* ================= Recommendations ================= */
function available() {
  const used = usedChamps();
  return Object.keys(CHAMPIONS).filter(k => !used.has(k) && !state.fearless.has(k));
}

function recommendations() {
  const idx = currentIndex();
  const enemySide = state.mySide === "blue" ? "red" : "blue";

  if (idx === -1) {
    return { title: "Draft complete", subtitle: "Review both comps below.", items: [] };
  }
  const step = state.seq[idx];
  const avail = available();

  if (step.type === "ban") {
    const forMe = step.side === state.mySide;
    const items = avail.map(k => ({ key: k, ...scoreBan(k, state.mySide) }))
      .sort((a, b) => b.score - a.score).slice(0, 10);
    return {
      title: forMe ? "Ban suggestions" : `${step.side.toUpperCase()} is banning — biggest threats`,
      subtitle: forMe ? "Deny the enemy's highest-value picks." : "What you'd most want gone.",
      items, mode: "ban",
    };
  }

  // Pick step — always recommend for MY team's next need; if it's the enemy's
  // pick, show their likely best picks instead (same engine, their side).
  const forMe = step.side === state.mySide;
  const side = forMe ? state.mySide : enemySide;
  const taken = new Set(teamPicks(side).map(p => p.role).filter(Boolean));
  let openRoles = ROLES.filter(r => !taken.has(r));
  if (state.recRole !== "all") openRoles = openRoles.filter(r => r === state.recRole);
  if (openRoles.length === 0) openRoles = state.recRole === "all" ? ROLES : [state.recRole];

  const earlyPick = step.slot <= 1;
  const lastPick = step.slot === 4;

  const items = [];
  avail.forEach(k => {
    const c = CHAMPIONS[k];
    openRoles.forEach(r => {
      if (!c.roles[r] && !(c.flex || []).includes(r)) return;
      const res = forMe
        ? scorePick(k, r, state.mySide, { earlyPick, lastPick })
        : scorePick(k, r, enemySide, { earlyPick, lastPick });
      items.push({ key: k, role: r, ...res });
    });
  });
  // keep best role per champion
  const best = {};
  items.forEach(it => { if (!best[it.key] || it.score > best[it.key].score) best[it.key] = it; });
  const sorted = Object.values(best).sort((a, b) => b.score - a.score).slice(0, 10);

  return {
    title: forMe ? `Best picks — your pick ${step.slot + 1}` : `${side.toUpperCase()} likely picks (threats)`,
    subtitle: forMe
      ? (lastPick ? "Last pick — counterpick freely." : earlyPick ? "Early pick — prioritize power + flex." : "Fill comp needs and matchups.")
      : "Their strongest options — consider answering or banning next phase.",
    items: sorted, mode: "pick",
  };
}

/* ================= Rendering ================= */
const $ = id => document.getElementById(id);

function render() {
  renderTrack();
  renderTeams();
  renderBanner();
  renderRecs();
  renderGrid();
  renderFearless();
  $("patch-label").textContent = `Patch ${PATCH} · solo queue + pro data · ${DATA_UPDATED}`;
  $("blue-you").classList.toggle("visible", state.mySide === "blue");
  $("red-you").classList.toggle("visible", state.mySide === "red");
  $("side-blue").classList.toggle("active", state.mySide === "blue");
  $("side-red").classList.toggle("active", state.mySide === "red");
  $("fp-blue").classList.toggle("active", state.firstPick === "blue");
  $("fp-red").classList.toggle("active", state.firstPick === "red");
  $("fearless-btn").classList.toggle("active", state.fearlessMode);
}

function renderTrack() {
  const idx = currentIndex();
  const track = $("draft-track");
  track.innerHTML = "";
  state.seq.forEach((st, i) => {
    // visual gaps between phases
    if (i === 6 || i === 12 || i === 16) {
      const gap = document.createElement("div");
      gap.className = "track-gap"; track.appendChild(gap);
    }
    const el = document.createElement("div");
    el.className = `track-step ${st.side} ${st.type}` +
      (i === idx && state.editing === null ? " current" : "") +
      (i === state.editing ? " editing" : "");
    const lbl = `${st.type === "ban" ? "B" : "P"}${st.slot + 1}`;
    const champ = state.actions[i];
    el.innerHTML = (champ ? champImgHTML(champ) : `<div class="ph">${st.type === "ban" ? "✕" : "+"}</div>`) +
      `<span>${st.side === "blue" ? "B" : "R"}·${lbl}</span>` +
      (st.type === "ban" && champ ? `<div class="slash">⃠</div>` : "");
    el.title = `${st.side} ${st.type} ${st.slot + 1}` + (champ ? ` — ${dispName(champ)} (click to change)` : "");
    el.onclick = () => {
      state.editing = (state.editing === i) ? null : i;
      render();
    };
    track.appendChild(el);
  });
}

function renderTeams() {
  ["blue", "red"].forEach(side => {
    const bansEl = $(side + "-bans");
    bansEl.innerHTML = "";
    state.seq.forEach((st, i) => {
      if (st.type !== "ban" || st.side !== side) return;
      const div = document.createElement("div");
      div.className = "ban-slot";
      const champ = state.actions[i];
      div.innerHTML = champ ? champImgHTML(champ) + `<div class="x">✕</div>` : "";
      div.title = champ ? `Banned: ${dispName(champ)}` : "Open ban";
      bansEl.appendChild(div);
    });

    const picksEl = $(side + "-picks");
    picksEl.innerHTML = "";
    state.seq.forEach((st, i) => {
      if (st.type !== "pick" || st.side !== side) return;
      const champ = state.actions[i];
      const div = document.createElement("div");
      div.className = "pick-slot";
      if (champ) {
        const role = state.roles[side][st.slot] || "?";
        const opts = ROLES.map(r =>
          `<option value="${r}" ${r === role ? "selected" : ""}>${ROLE_ICON[r]} ${ROLE_LABEL[r]}</option>`).join("");
        div.innerHTML = champImgHTML(champ) +
          `<div class="pick-info"><div class="nm">${dispName(champ)}</div>
           <select data-side="${side}" data-slot="${st.slot}">${opts}</select></div>`;
        div.querySelector("select").onchange = e => {
          pushUndo();
          state.roles[side][st.slot] = e.target.value;
          render();
        };
      } else {
        div.innerHTML = `<div class="ph">+</div><div class="pick-info"><div class="nm" style="color:var(--text-dim)">Pick ${st.slot + 1}</div></div>`;
      }
      picksEl.appendChild(div);
    });

    renderComp(side);
  });
}

function renderComp(side) {
  const el = $(side + "-comp");
  const picks = teamPicks(side);
  if (picks.length === 0) { el.innerHTML = ""; return; }
  const s = compStats(picks);
  const total = s.ad + s.ap || 1;
  const adPct = Math.round(s.ad / total * 100);
  const meter = (val, max) => `<div class="meter">${[...Array(5)].map((_, i) =>
    `<i class="${val / max * 5 > i ? "on" : ""}"></i>`).join("")}</div>`;

  const warns = [];
  if (s.n >= 3 && s.ap < 0.6) warns.push("All-AD — easy to itemize against");
  if (s.n >= 3 && s.ad < 0.6) warns.push("All-AP — easy to itemize against");
  if (s.n >= 3 && s.front < 3) warns.push("Lacks frontline");
  if (s.n >= 4 && s.engage < 2) warns.push("No hard engage");
  if (s.n >= 4 && s.cc < 4) warns.push("Low CC");

  el.innerHTML = `
    <div class="comp-row"><span class="lbl">Damage profile</span>
      <div class="dmg-bar"><div class="ad" style="width:${adPct}%"></div><div class="ap" style="width:${100 - adPct}%"></div></div>
      <div class="dmg-lbls"><span>AD ${adPct}%</span><span>AP ${100 - adPct}%</span></div></div>
    <div class="comp-row"><span class="lbl">Frontline</span>${meter(s.front, 7)}</div>
    <div class="comp-row"><span class="lbl">Crowd control</span>${meter(s.cc, 9)}</div>
    <div class="comp-row"><span class="lbl">Early game</span>${meter(s.early, 12)}</div>
    <div class="comp-row"><span class="lbl">Late game</span>${meter(s.late, 12)}</div>
    ${warns.map(w => `<div class="comp-warn">⚠ ${w}</div>`).join("")}
    ${warns.length === 0 && s.n >= 3 ? `<div class="comp-ok">✓ Comp looks coherent</div>` : ""}`;
}

function renderBanner() {
  const idx = currentIndex();
  const el = $("step-banner");
  if (state.editing !== null) {
    const st = state.seq[state.editing];
    el.innerHTML = `Editing ${st.side.toUpperCase()} ${st.type} ${st.slot + 1} — click a champion to replace, or click the slot again to cancel`;
    return;
  }
  if (idx === -1) {
    el.innerHTML = `Draft complete <div class="sub">Compare comps in the side panels. Click any slot above to revise.</div>`;
    return;
  }
  const st = state.seq[idx];
  const yours = st.side === state.mySide ? " (YOUR TEAM)" : " (enemy)";
  el.innerHTML = `${st.side.toUpperCase()} ${st.type.toUpperCase()} ${st.slot + 1}${yours}
    <div class="sub">${st.type === "ban" ? "Click a champion in the grid to ban." : "Click a champion in the grid to lock in."}
    Phase ${st.phase} · ${state.firstPick === state.mySide ? "you have first pick" : "enemy has first pick"}</div>`;
}

function renderRecs() {
  const rec = recommendations();
  $("recs-title").textContent = rec.title;
  const list = $("recs-list");
  if (!rec.items.length) {
    list.innerHTML = `<div class="recs-empty">${rec.subtitle || "No suggestions."}</div>`;
    return;
  }
  list.innerHTML = "";
  rec.items.forEach(it => {
    const card = document.createElement("div");
    card.className = "rec-card";
    const shown = it.reasons.slice(0, 4);
    card.innerHTML = champImgHTML(it.key) +
      `<div class="rec-main"><span class="rec-name">${dispName(it.key)}</span>` +
      (it.role ? `<span class="rec-role">${ROLE_ICON[it.role]} ${ROLE_LABEL[it.role]}</span>` : "") +
      `<div class="rec-reasons">${shown.map(([sign, txt]) =>
        `<span class="reason-chip ${sign === "+" ? "plus" : "minus"}">${sign === "+" ? "▲" : "▼"} ${txt}</span>`).join("")}</div></div>` +
      `<div class="rec-score">${it.score.toFixed(1)}</div>`;
    card.title = it.reasons.map(([s, t]) => `${s} ${t}`).join("\n");
    card.onclick = () => assignChamp(it.key, it.role);
    list.appendChild(card);
  });
}

function renderGrid() {
  const grid = $("champ-grid");
  grid.innerHTML = "";
  const used = usedChamps();
  const q = norm(state.search);
  const keys = Object.keys(CHAMPIONS).sort((a, b) => dispName(a).localeCompare(dispName(b)));
  keys.forEach(k => {
    const c = CHAMPIONS[k];
    if (q && !norm(dispName(k)).includes(q) && !norm(k).includes(q)) return;
    if (state.gridRole !== "all" && !c.roles[state.gridRole] && !(c.flex || []).includes(state.gridRole)) return;
    const cell = document.createElement("div");
    cell.className = "champ-cell" + (used.has(k) ? " used" : "") + (state.fearless.has(k) ? " fearless-out" : "");
    cell.innerHTML = champImgHTML(k) + `<span>${dispName(k)}</span>`;
    cell.onclick = () => {
      if (state.fearlessMode) {
        pushUndo();
        state.fearless.has(k) ? state.fearless.delete(k) : state.fearless.add(k);
        render();
      } else if (!state.fearless.has(k)) {
        assignChamp(k);
      }
    };
    grid.appendChild(cell);
  });
}

function renderFearless() {
  $("fearless-bar").classList.toggle("visible", state.fearlessMode || state.fearless.size > 0);
  const chips = $("fearless-chips");
  chips.innerHTML = [...state.fearless].map(k =>
    `<span class="fearless-chip" data-k="${k}">${dispName(k)} ✕</span>`).join(" ");
  chips.querySelectorAll(".fearless-chip").forEach(ch => {
    ch.onclick = () => { pushUndo(); state.fearless.delete(ch.dataset.k); render(); };
  });
}

/* ================= Actions ================= */
function assignChamp(key, roleHint) {
  const idx = currentIndex();
  if (idx === -1) return;
  pushUndo();
  const st = state.seq[idx];
  // if replacing an existing pick, clear its old role
  if (state.actions[idx] && st.type === "pick") state.roles[st.side][st.slot] = null;
  state.actions[idx] = key;
  if (st.type === "pick") {
    state.roles[st.side][st.slot] = roleHint || inferRole(st.side, key);
  }
  state.editing = null;
  render();
}

function rebuild(firstPick) {
  // rebuild sequence, remapping existing actions by (side, type, slot)
  const old = state.seq.map((st, i) => ({ ...st, champ: state.actions[i] }));
  state.firstPick = firstPick;
  state.seq = buildSequence(firstPick);
  state.actions = state.seq.map(st => {
    const m = old.find(o => o.side === st.side && o.type === st.type && o.slot === st.slot);
    return m ? m.champ : null;
  });
  state.editing = null;
}

/* ================= Wiring ================= */
$("side-blue").onclick = () => { state.mySide = "blue"; render(); };
$("side-red").onclick = () => { state.mySide = "red"; render(); };
$("fp-blue").onclick = () => { pushUndo(); rebuild("blue"); render(); };
$("fp-red").onclick = () => { pushUndo(); rebuild("red"); render(); };
$("undo-btn").onclick = undo;
$("reset-btn").onclick = () => {
  pushUndo();
  state.actions = new Array(20).fill(null);
  state.roles = { blue: new Array(5).fill(null), red: new Array(5).fill(null) };
  state.editing = null;
  render();
};
$("fearless-btn").onclick = () => { state.fearlessMode = !state.fearlessMode; render(); };
$("champ-search").oninput = e => { state.search = e.target.value; renderGrid(); };
$("rec-role-filter").onchange = e => { state.recRole = e.target.value; renderRecs(); };
document.querySelectorAll("#role-filters button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#role-filters button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    state.gridRole = b.dataset.role;
    renderGrid();
  };
});

render();
