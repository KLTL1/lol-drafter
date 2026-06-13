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

  // Team comp needs — weighted up so a cohesive comp is favored over a raw-meta pick
  const comp = compStats(allies);
  if (comp.n >= 2) {
    if (comp.ap === 0 && c.dmg === "ap") { score += 2.4; reasons.push(["+", "adds AP damage"]); }
    if (comp.ad === 0 && c.dmg === "ad") { score += 2.4; reasons.push(["+", "adds AD damage"]); }
    if (c.dmg === "mix" && (comp.ap < 1 || comp.ad < 1)) { score += 1.1; reasons.push(["+", "mixed damage"]); }
    if (comp.front < 3 && c.a.front >= 2) { score += 2.0; reasons.push(["+", "adds frontline"]); }
    if (comp.cc < 4 && c.a.cc >= 2) { score += 1.4; reasons.push(["+", "adds CC"]); }
    if (comp.engage < 2 && c.a.engage >= 2) { score += 1.7; reasons.push(["+", "adds engage"]); }
    if (comp.late >= 5 && comp.peel < 3 && c.a.peel >= 2) { score += 1.4; reasons.push(["+", "peel for carries"]); }
    // win-condition coherence
    const lean = comp.early - comp.late;
    if (lean >= 2 && c.a.early >= 2) { score += 0.9; reasons.push(["+", "fits early-game plan"]); }
    if (lean <= -2 && c.a.late >= 2) { score += 0.9; reasons.push(["+", "fits scaling plan"]); }
  }

  // Enemy comp counters — also weighted up (draft to beat their comp)
  const ecomp = compStats(enemies);
  if (ecomp.n >= 3) {
    if (ecomp.ap < 0.6 && c.a.front >= 2) { score += 1.0; reasons.push(["+", "tanky vs their full-AD"]); }
    if (ecomp.ad < 0.6 && c.a.front >= 2) { score += 0.7; reasons.push(["+", "tanky vs their full-AP"]); }
    if (ecomp.poke >= 5 && c.a.engage >= 2) { score += 1.2; reasons.push(["+", "engage vs poke comp"]); }
    if (ecomp.engage >= 3 && c.a.peel >= 2) { score += 1.0; reasons.push(["+", "disengage vs their dive"]); }
    if (ecomp.split >= 3 && (c.a.split >= 2 || c.a.wave >= 2)) { score += 0.6; reasons.push(["+", "answers their split"]); }
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
  renderGamePlan();
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

/* ================= Game plan ================= */
function teamProfile(picks) {
  const champs = picks.map(p => ({ key: p.key, role: p.role, c: CHAMPIONS[p.key] }));
  const s = compStats(picks);
  const names = f => champs.filter(f).map(x => dispName(x.key));
  const engageMax = champs.length ? Math.max(...champs.map(x => x.c.a.engage)) : 0;
  // primary carry = best late-game non-frontline damage threat
  const carries = champs.filter(x => x.c.a.late >= 3 && x.c.a.front <= 1)
    .sort((a, b) => (b.c.a.late - a.c.a.late) || ((b.c.pro.p || 0) - (a.c.pro.p || 0)));
  return {
    n: champs.length, s, engageMax,
    engagers: names(x => x.c.a.engage >= 2),
    divers: names(x => x.c.a.engage >= 2 && x.c.a.front <= 1),     // mobile/flank engage
    frontliners: names(x => x.c.a.front >= 2),
    pokers: names(x => x.c.a.poke >= 2),
    splitters: names(x => x.c.a.split >= 3),
    peelers: names(x => x.c.a.peel >= 2),
    earlies: names(x => x.c.a.early >= 3),
    lates: names(x => x.c.a.late >= 3),
    catchers: names(x => x.c.a.engage >= 2 && x.c.a.early >= 3),
    carries: carries.map(x => dispName(x.key)),
    carry: carries.length ? dispName(carries[0].key) : null,
  };
}

function archetypeScores(p) {
  const s = p.s;
  return {
    teamfight: s.cc * 0.5 + p.engageMax * 1.6 + s.front * 0.45,
    poke: s.poke * 1.3,
    protect: (p.carry && p.peelers.length ? 3.5 : 0) + s.peel * 0.9,
    split: s.split * 0.9 + (p.splitters.length ? 2 : 0),
    early: Math.max(0, s.early - s.late) * 2.2,
    scale: Math.max(0, s.late - s.early) * 2.2,
  };
}
function archetype(p) {
  if (p.n === 0) return null;
  return Object.entries(archetypeScores(p)).sort((a, b) => b[1] - a[1])[0][0];
}
const ARCH_LABEL = {
  teamfight: "teamfight/engage", poke: "poke-siege", protect: "protect-the-carry",
  split: "split-push", early: "early-game tempo", scale: "scaling",
};
// rock-paper-scissors edges: key beats listed archetypes
const ARCH_BEATS = {
  teamfight: ["poke", "scale"], split: ["teamfight"],
  early: ["scale", "protect"], poke: ["protect"], scale: ["poke"],
};
function archetypeEdge(a, b) {
  if ((ARCH_BEATS[a] || []).includes(b)) return 1;
  if ((ARCH_BEATS[b] || []).includes(a)) return -1;
  return 0;
}

const joinNames = arr => (arr && arr.length ? arr.slice(0, 3).join(", ") : "");

/* ---- lane-by-lane matchup analysis ---- */
function laneAnalysis(myPicks, enemyPicks) {
  let net = 0; const edges = [];
  myPicks.forEach(p => {
    const opp = enemyPicks.find(e => e.role === p.role);
    if (!opp) return;
    const c = CHAMPIONS[p.key], oc = CHAMPIONS[opp.key];
    const good = listHas(c.beats, opp.key) || listHas(oc.counteredBy, p.key);
    const bad = listHas(c.counteredBy, opp.key) || listHas(oc.beats, p.key);
    if (good && !bad) { net++; edges.push({ role: p.role, winner: "me", short: `${dispName(p.key)} > ${dispName(opp.key)}`, text: `${dispName(p.key)} beats ${dispName(opp.key)} ${ROLE_LABEL[p.role]}` }); }
    else if (bad && !good) { net--; edges.push({ role: p.role, winner: "en", short: `${dispName(opp.key)} > ${dispName(p.key)}`, text: `${dispName(opp.key)} beats ${dispName(p.key)} ${ROLE_LABEL[p.role]}` }); }
  });
  return { net, edges, strongest: edges.find(e => e.winner === "me") || null, weakest: edges.find(e => e.winner === "en") || null };
}

/* ---- comp cohesion: how complete/balanced a team is ---- */
function cohesionScore(p) {
  if (!p.n) return 0;
  let s = 0;
  const tot = p.s.ad + p.s.ap || 1, adFrac = p.s.ad / tot;
  s -= Math.max(0, Math.abs(adFrac - 0.5) - 0.18) * 5;       // one-dimensional damage
  if (p.s.front >= 3) s += 0.8; else if (p.s.front < 2) s -= 1.6;
  if (p.engageMax >= 2) s += 0.6; else s -= 1.2;
  if (p.s.cc >= 5) s += 0.5; else if (p.s.cc < 4) s -= 0.8;
  if (p.carry && !p.peelers.length) s -= 0.6;
  return s;
}
function cohesionGap(p) {
  if (p.s.front < 2) return "no reliable frontline";
  const tot = p.s.ad + p.s.ap || 1, f = p.s.ad / tot;
  if (Math.abs(f - 0.5) > 0.32) return f > 0.5 ? "all-AD damage (easily itemized)" : "all-AP damage (easily itemized)";
  if (p.engageMax < 2) return "no hard engage";
  if (p.s.cc < 4) return "very little CC";
  if (p.carry && !p.peelers.length) return "no peel for its carry";
  return "a thinner overall comp";
}
function synergyCount(picks) {
  let c = 0;
  for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) {
    const a = CHAMPIONS[picks[i].key], b = CHAMPIONS[picks[j].key];
    if (listHas(a.syn, picks[j].key) || listHas(b.syn, picks[i].key)) c++;
  }
  return c;
}

/* ---- draft evaluation → win probability + reasons ---- */
function metaStrength(picks) {
  return picks.reduce((sum, p) => {
    const c = CHAMPIONS[p.key], rd = c.roles[p.role];
    return sum + (rd ? (rd.wr - 50) * 0.4 + (TIER_BONUS[rd.tier] || 0) : -0.8) + proScore(c) * 0.22;
  }, 0);
}
function draftEvaluation(myPicks, enemyPicks) {
  const my = teamProfile(myPicks), en = teamProfile(enemyPicks);
  if (my.n < 2 || en.n < 2) return null;
  const factors = []; let net = 0;

  const la = laneAnalysis(myPicks, enemyPicks);
  if (la.net !== 0) {
    const d = la.net * 0.8; net += d;
    const side = d > 0 ? "me" : "en";
    factors.push({ delta: d, text: `${d > 0 ? "Lane matchups favor you" : "Lane matchups favor them"}: ${la.edges.filter(e => e.winner === side).map(e => e.short).slice(0, 3).join(", ")}` });
  }

  const md = metaStrength(myPicks) - metaStrength(enemyPicks);
  if (Math.abs(md) > 0.6) {
    const d = md * 0.35; net += d;
    factors.push({ delta: d, text: d > 0 ? "Your champions are individually stronger on patch 26.12" : "Their champions are individually stronger on patch 26.12" });
  }

  const cw = Math.min(my.n, en.n) / 5;                       // cohesion matters more as comps fill out
  const cd = (cohesionScore(my) - cohesionScore(en)) * 1.15 * cw;
  if (Math.abs(cd) > 0.3) {
    net += cd;
    factors.push({ delta: cd, text: cd > 0 ? `Your comp is more cohesive — theirs has ${cohesionGap(en)}` : `Their comp is more cohesive — yours has ${cohesionGap(my)}` });
  }

  const sd = (synergyCount(myPicks) - synergyCount(enemyPicks)) * 0.5;
  if (Math.abs(sd) > 0.4) { net += sd; factors.push({ delta: sd, text: sd > 0 ? "More pick synergies on your side" : "They have more pick synergies" }); }

  const ae = archetypeEdge(archetype(my), archetype(en));
  if (ae) {
    const d = ae * 1.1; net += d;
    factors.push({ delta: d, text: d > 0
      ? `Your ${ARCH_LABEL[archetype(my)]} style is favored into their ${ARCH_LABEL[archetype(en)]} comp`
      : `Their ${ARCH_LABEL[archetype(en)]} style is favored into your ${ARCH_LABEL[archetype(my)]} comp` });
  }

  let prob = 1 / (1 + Math.exp(-net * 0.13));
  prob = Math.max(0.22, Math.min(0.78, prob));
  factors.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { myProb: prob, my, en, lane: la, factors, full: my.n >= 5 && en.n >= 5 };
}

/* ---- detailed win condition (style + phase plan) ---- */
function winCondition(p) {
  const eng = joinNames(p.engagers) || "your frontline";
  const carry = p.carry || joinNames(p.carries) || "your carry";
  const A = {
    teamfight: { style: "Teamfight / Engage",
      summary: `Win the game in 5v5s around objectives — ${eng} picks when to commit and the team collapses behind it, with ${carry} doing the damage once the fight is locked.`,
      early: `You don't need lane leads, you need everyone healthy at the first drake/grub timers. Stack waves and arrive with summoner spells up.`,
      mid: `Group as 5 by mid game. Start fights at Dragon/Baron with ${eng}, and bait the enemy into chokes where your AoE and CC overlap.`,
      fights: `Land engage on their highest-value target${p.divers.length ? ` (flank with ${joinNames(p.divers)})` : ""}; hold CC until their key escape/peel is used, then chain it.` },
    poke: { style: "Poke / Siege",
      summary: `Win without ever taking a fair fight — ${joinNames(p.pokers)} chunk them below turret, then you take the objective for free.`,
      early: `Shove and poke for a health lead; avoid all-ins, your power is range and zone control, not extended trades.`,
      mid: `Play every objective on a timer: poke them off it, then take it uncontested. Always keep a wall or minions between you and their engage.`,
      fights: `Never start the fight. Whittle them on the approach, and if they hard-engage, disengage and reset — repeat until they're too low to contest.` },
    protect: { style: "Protect-the-Carry",
      summary: `Funnel the game into ${carry} and win extended fights — ${joinNames(p.peelers) || "your supports"} keep ${carry} alive and free to deal damage.`,
      early: `Get ${carry} farmed and safe; trade other lanes and jungle pathing for ${carry}'s comfort and tempo.`,
      mid: `Group for objectives but fight on your terms: stand on top of ${carry}, body-block divers, and don't get split off.`,
      fights: `${carry} holds max range and never walks up first. Peelers answer the first engage; the whole fight is about ${carry} surviving the opening 5 seconds.` },
    split: { style: "Split-Push / 1-3-1",
      summary: `Stretch the map — ${joinNames(p.splitters)} pressure a side lane while the other four hold and threaten objectives cross-map.`,
      early: `Win or stabilize the side lane that splits and bank a Teleport/wave advantage; don't force the 5v5s you're not built for.`,
      mid: `Run 1-3-1 once outer towers fall: ${joinNames(p.splitters)} pushes a side, the rest match or take objectives elsewhere. Trade towers, don't group 5 mid.`,
      fights: `Avoid 5v5. Win the 1v1/1v2 on the splitter and the 4v4 elsewhere; only group when they fully collapse to stop the split.` },
    early: { style: "Early-Game / Tempo",
      summary: `Snowball before ~20 min — ${joinNames(p.earlies)} spike first, so turn early kills into objectives into towers fast.`,
      early: `Be the aggressor everywhere: invade, dive, and prioritize early skirmishes and the first drakes/grubs while you're strongest.`,
      mid: `Convert leads immediately — take towers and Baron-side objectives off the back of kills. Do not let the game slow down.`,
      fights: `Force fights while you hold the level/item edge and collapse on isolated targets; the longer it goes, the worse your odds.` },
    scale: { style: "Scaling / Late-Game",
      summary: `Out-scale them — survive early, farm cleanly, and take over after 25+ min once ${joinNames(p.lates)} are online.`,
      early: `Play safe and even: concede small pressure, don't die for nothing, value farm and scaling over early fights.`,
      mid: `Trade objectives for time. Give up what you can't safely contest and ward deep to avoid picks while your carries catch up.`,
      fights: `Delay fights until your item spikes, then group for Baron/Elder with full builds — one clean late teamfight closes it.` },
  };
  return A[archetype(p)] || { style: "Flexible",
    summary: "No single identity yet — win through whichever lanes get ahead and shape the mid-game around your leads.",
    early: "Play to your strongest matchups.", mid: "Take objectives where you have priority.", fights: "Fight when you have numbers or a pick." };
}

function gamePlanBullets(myPicks, enemyPicks, my, en) {
  const b = [];
  const la = laneAnalysis(myPicks, enemyPicks);
  const myLean = my.s.late - my.s.early, enLean = en.s.late - en.s.early;

  if (myLean - enLean >= 2) b.push("You out-scale them. Respect their early aggression, don't take coin-flip fights before 20 min, and trade objectives for safe farm — time is on your side.");
  else if (enLean - myLean >= 2) b.push("Your advantage has a timer — they out-scale you. Force early skirmishes and dives, take objectives on spawn, and aim to close before ~30 min.");
  else b.push("Tempo is even — this game is decided by lane matchups and objective setups, not by stalling or rushing.");

  if (la.strongest) b.push(`Snowball your best lane: ${la.strongest.text}. Path your jungle there early, set up dives, and turn that lead into objectives.`);
  if (la.weakest) b.push(`Protect your weakest lane: ${la.weakest.text}. Help early, freeze/give up CS rather than die, and don't force that matchup 1v1.`);

  if (en.s.poke >= 5 && my.engageMax >= 2) b.push(`They want to poke you out before fights start. Don't dance at max range — force the engage with ${joinNames(my.engagers)}, or fight from fog and chokes where poke can't stack.`);
  if (my.s.poke >= 5 && en.engageMax >= 3) b.push(`Poke before objectives but track engage cooldowns on ${joinNames(en.engagers)} — keep spacing and disengage their flank.`);

  if (en.splitters.length) b.push(`${joinNames(en.splitters)} will splitpush. Don't send three to stop it — match with one side-laner, or trade objectives 4v4 on the opposite side.`);
  if (my.splitters.length && my.s.split >= 5) b.push(`Use ${joinNames(my.splitters)}'s side pressure: set up 1-3-1 once laning ends, and only group when they fully collapse.`);

  if (en.n >= 4 && en.s.ap < 0.6) b.push("Their damage is almost all AD — armor on your frontline (Randuin's, Frozen Heart, Plated/Tabis) blunts their whole comp.");
  if (en.n >= 4 && en.s.ad < 0.6) b.push("Their damage is almost all AP — rush MR on the frontline (Spirit Visage, Force of Nature, Mercs) and they run out of ways to kill you.");
  if (my.n >= 4 && my.s.ap < 0.6) b.push("Your damage is all AD — they'll stack armor; pick up armor pen / Black Cleaver and close before their defensive items come online.");
  if (my.n >= 4 && my.s.ad < 0.6) b.push("Your damage is all AP — expect MR stacking; time Void Staff / Shadowflame purchases and don't let it drag.");

  if (en.catchers.length) b.push(`Don't get caught: ${joinNames(en.catchers)} turns one pick into a lost game. Control wards, move in pairs after 20 min, never facecheck a brush.`);
  if (en.carry && my.engageMax >= 2) b.push(`Their game runs through ${en.carry} — assign your engage/dive to it first and burst it before it does damage.`);
  if (my.carry && en.engageMax >= 2) b.push(`${my.carry} is your win condition — buy Stopwatch/Zhonya's or QSS into their engage and position last in every fight.`);

  return b.slice(0, 8);
}

function outlookHTML(myPicks, enemyPicks, myLabel, enLabel, myColor, enColor) {
  const ev = draftEvaluation(myPicks, enemyPicks);
  if (!ev) return "";
  const myPct = Math.round(ev.myProb * 100), enPct = 100 - myPct;
  const favMe = myPct >= enPct;
  const favLabel = favMe ? myLabel : enLabel;
  const tilt = Math.abs(myPct - 50);
  const verdict = tilt < 4 ? "Even draft" : tilt < 10 ? `Slight edge: ${favLabel}` : tilt < 18 ? `Favored: ${favLabel}` : `Strongly favored: ${favLabel}`;
  const facts = ev.factors.slice(0, 5).map(f => {
    const mine = f.delta > 0;
    return `<li class="${mine ? "ol-plus" : "ol-minus"}">${mine ? "▲" : "▼"} ${f.text}</li>`;
  }).join("");
  return `
    <div class="outlook">
      <div class="ol-head"><span>Draft outlook</span><span class="ol-verdict">${verdict}${ev.full ? "" : " · provisional"}</span></div>
      <div class="ol-bar">
        <div class="ol-me" style="width:${myPct}%;background:${myColor}">${myLabel} ${myPct}%</div>
        <div class="ol-en" style="width:${enPct}%;background:${enColor}">${enPct}% ${enLabel}</div>
      </div>
      <ul class="ol-why">${facts || '<li class="ol-even">Comps are close on every axis so far.</li>'}</ul>
    </div>`;
}

function winConColsHTML(my, en, enColor) {
  const wc = winCondition(my), ec = winCondition(en);
  const block = (w, color, label) => `
    <div class="gp-win" style="border-left:3px solid ${color}">
      <div class="gp-lbl">${label}</div>
      <div class="wc-style">${w.style}</div>
      <div class="wc-summary">${w.summary}</div>
      <div class="wc-phases">
        <div><span class="wc-ph">Early</span> ${w.early}</div>
        <div><span class="wc-ph">Mid &amp; objectives</span> ${w.mid}</div>
        <div><span class="wc-ph">Teamfights</span> ${w.fights}</div>
      </div>
    </div>`;
  return `<div class="gp-cols">${block(wc, "var(--gold)", "Your win condition")}${block(ec, enColor, "Enemy win condition")}</div>`;
}

function renderGamePlan() {
  const el = $("gameplan");
  const enemySide = state.mySide === "blue" ? "red" : "blue";
  const myPicks = teamPicks(state.mySide), enPicks = teamPicks(enemySide);
  const my = teamProfile(myPicks), en = teamProfile(enPicks);
  if (my.n < 2 || en.n < 2) {
    el.innerHTML = `<div class="gp-empty">Draft outlook, win conditions and the matchup plan appear once both teams have at least 2 picks.</div>`;
    return;
  }
  const partial = (my.n < 5 || en.n < 5) ? `<div class="gp-note">Draft in progress — the outlook and plan sharpen as more picks lock in.</div>` : "";
  const myColor = state.mySide === "blue" ? "var(--blue-team)" : "var(--red-team)";
  const enColor = enemySide === "blue" ? "var(--blue-team)" : "var(--red-team)";
  const myLabel = state.mySide === "blue" ? "BLUE" : "RED", enLabel = enemySide === "blue" ? "BLUE" : "RED";
  el.innerHTML = partial
    + outlookHTML(myPicks, enPicks, myLabel, enLabel, myColor, enColor)
    + winConColsHTML(my, en, enColor)
    + `<div class="gp-lbl">How to play it</div>
       <ul class="gp-list">${gamePlanBullets(myPicks, enPicks, my, en).map(t => `<li>${t}</li>`).join("")}</ul>`;
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

/* ============================================================
   FLEX QUEUE MODE — recommendations limited to the 5 players'
   champion pools. No bans, no draft order; just input champions.
   ============================================================ */
const flex = {
  mine: { top:null, jungle:null, mid:null, adc:null, support:null }, // role -> champ key
  enemy: [],          // [{key, role}]
  addSide: "enemy",
  search: "",
  gridRole: "all",
};

function flexUsed() {
  const s = new Set(flex.enemy.map(e => e.key));
  Object.values(flex.mine).forEach(k => { if (k) s.add(k); });
  return s;
}
function flexMyPicks() {
  return ROLES.filter(r => flex.mine[r]).map(r => ({ key: flex.mine[r], role: r }));
}

function flexInferEnemyRole(key) {
  const taken = new Set(flex.enemy.map(e => e.role));
  let open = ROLES.filter(r => !taken.has(r));
  if (!open.length) open = ROLES;
  const c = CHAMPIONS[key];
  let best = open[0], bestS = -Infinity;
  open.forEach(r => {
    const rd = c.roles[r];
    const s = rd ? rd.pr + (rd.wr - 48) : (c.flex || []).includes(r) ? 0.5 : -5;
    if (s > bestS) { bestS = s; best = r; }
  });
  return best;
}

function flexScore(key, role, myPicks, comfort) {
  const c = CHAMPIONS[key];
  const reasons = [];
  let score = 0;
  // Comfort matters in flex — but comp cohesion (below) is weighted up enough that
  // a learnable/similar pick can win out when the team really needs what it brings.
  score += comfort === 3 ? 3.6 : comfort === 2 ? 2.3 : 1.0;
  // meta strength in role
  const rd = c.roles[role];
  if (rd) {
    score += (rd.wr - 50) * 0.45 + (TIER_BONUS[rd.tier] || 0);
    if (rd.wr >= 51.5) reasons.push(["+", `${rd.wr}% WR`]);
    if (rd.wr < 48.5) reasons.push(["-", `${rd.wr}% WR`]);
  }
  score += proScore(c) * 0.3;
  if (META.patchBuffs.includes(key)) { score += 0.5; reasons.push(["+", "buffed 26.12"]); }
  if (META.patchNerfs.includes(key)) { score -= 0.5; reasons.push(["-", "nerfed 26.12"]); }

  // matchups vs enemy
  flex.enemy.forEach(e => {
    const ec = CHAMPIONS[e.key];
    const same = e.role === role;
    const w = same ? 2.2 : 0.5;
    const bad = listHas(c.counteredBy, e.key) || listHas(ec.beats, key);
    const good = listHas(c.beats, e.key) || listHas(ec.counteredBy, key);
    if (good && !bad) { score += w; reasons.push(["+", `strong vs ${dispName(e.key)}`]); }
    if (bad && !good) { score -= w; reasons.push(["-", `weak vs ${dispName(e.key)}`]); }
  });

  // synergy with already-locked teammates
  myPicks.forEach(a => {
    if (a.key === key) return;
    const ac = CHAMPIONS[a.key];
    if (listHas(c.syn, a.key) || listHas(ac.syn, key)) { score += 1.1; reasons.push(["+", `synergy ${dispName(a.key)}`]); }
  });

  // comp needs — weighted up per request: lean toward a cohesive comp vs the enemy
  const comp = compStats(myPicks);
  if (comp.n >= 1) {
    if (comp.ap === 0 && c.dmg === "ap") { score += 2.1; reasons.push(["+", "adds AP"]); }
    if (comp.ad === 0 && c.dmg === "ad") { score += 2.1; reasons.push(["+", "adds AD"]); }
    if (comp.front < 3 && c.a.front >= 2) { score += 1.7; reasons.push(["+", "frontline"]); }
    if (comp.engage < 2 && c.a.engage >= 2) { score += 1.6; reasons.push(["+", "engage"]); }
    if (comp.cc < 4 && c.a.cc >= 2) { score += 0.9; reasons.push(["+", "CC"]); }
    if (comp.late >= 4 && comp.peel < 3 && c.a.peel >= 2) { score += 1.0; reasons.push(["+", "peel"]); }
  }
  // counter the enemy comp shape
  const ec = compStats(flex.enemy);
  if (ec.n >= 3) {
    if (ec.ap < 0.6 && c.a.front >= 2) { score += 0.9; reasons.push(["+", "tanky vs their AD"]); }
    if (ec.poke >= 5 && c.a.engage >= 2) { score += 1.0; reasons.push(["+", "engage vs poke"]); }
    if (ec.engage >= 3 && c.a.peel >= 2) { score += 0.8; reasons.push(["+", "disengage vs dive"]); }
  }
  return { score, reasons };
}

function flexRecsFor(playerIdx) {
  const player = PLAYERS[playerIdx];
  const role = player.role;
  const used = flexUsed();
  const myPicks = flexMyPicks().filter(p => p.role !== role); // exclude their own slot
  const comfortLabel = { 3: "main / high mastery", 2: "in champ pool", 1: "comfort pick" };
  const seen = {};
  player.pool.forEach(entry => {
    const r = entry.alt || role;
    if (r !== role) return;                 // only this player's assigned role
    if (used.has(entry.key)) return;
    if (!CHAMPIONS[entry.key]) return;
    const res = flexScore(entry.key, role, myPicks, entry.comfort);
    const base = [["c" + entry.comfort, entry.like ? `like ${entry.like}` : comfortLabel[entry.comfort]]];
    const item = { key: entry.key, comfort: entry.comfort, score: res.score, reasons: base.concat(res.reasons) };
    if (!seen[entry.key] || item.score > seen[entry.key].score) seen[entry.key] = item;
  });
  return Object.values(seen).sort((a, b) => b.score - a.score);
}

function renderFlexMine() {
  const el = $("flex-mine");
  el.innerHTML = "";
  PLAYERS.forEach((player, idx) => {
    const role = player.role;
    const locked = flex.mine[role];
    const card = document.createElement("div");
    card.className = "fp-card";
    let body;
    if (locked) {
      const entry = player.pool.find(e => e.key === locked);
      const sub = entry ? (entry.like ? `comfort pick — like ${entry.like}` : (entry.comfort === 3 ? "mastery main" : "in champ pool")) : "off-pool pick";
      body = `<div class="fp-locked">${champImgHTML(locked)}
        <div><div class="lk-name">${dispName(locked)}</div><div class="lk-sub">${sub}</div></div>
        <button class="fp-clear" data-role="${role}">✕ change</button></div>`;
    } else {
      const recs = flexRecsFor(idx).slice(0, 3);
      body = `<div class="fp-recs">` + (recs.length ? recs.map(r => {
        const reason = (r.reasons.find(x => x[0] === "+") || r.reasons[0] || ["", ""])[1];
        return `<div class="fp-rec" data-role="${role}" data-key="${r.key}">
          ${champImgHTML(r.key)}
          <div class="r-main"><div class="r-name"><span class="comfort-dot comfort-${r.comfort}"></span>${dispName(r.key)}</div>
          <div class="r-reason">${reason}</div></div>
          <div class="r-score">${r.score.toFixed(1)}</div></div>`;
      }).join("") : `<div class="gp-empty">No available pool champ for this role.</div>`) + `</div>`;
    }
    card.innerHTML = `
      <div class="fp-head">
        <span class="fp-role">${ROLE_ICON[role]}</span>
        <span class="fp-name">${player.name}</span>
        <span class="fp-rank">${player.rank}</span>
        <span class="fp-roletag">${ROLE_LABEL[role]}</span>
      </div>
      <div class="fp-body">${body}</div>`;
    el.appendChild(card);
  });
  el.querySelectorAll(".fp-rec").forEach(r => {
    r.onclick = () => { flex.mine[r.dataset.role] = r.dataset.key; renderFlex(); };
  });
  el.querySelectorAll(".fp-clear").forEach(b => {
    b.onclick = () => { flex.mine[b.dataset.role] = null; renderFlex(); };
  });
}

function renderFlexEnemy() {
  const el = $("flex-enemy");
  el.innerHTML = "";
  $("flex-enemy-count").textContent = `${flex.enemy.length} / 5`;
  for (let i = 0; i < 5; i++) {
    const e = flex.enemy[i];
    const slot = document.createElement("div");
    slot.className = "fe-slot" + (e ? " filled" : "");
    if (e) {
      slot.innerHTML = `${champImgHTML(e.key)}<div class="fe-name">${dispName(e.key)}</div><div class="fe-role">${ROLE_LABEL[e.role]}</div>`;
      slot.title = "Click to remove";
      slot.onclick = () => { flex.enemy.splice(i, 1); renderFlex(); };
    } else {
      slot.innerHTML = `<div class="fe-empty">empty</div>`;
    }
    el.appendChild(slot);
  }
}

function renderFlexGamePlan() {
  const el = $("flex-gameplan");
  const myPicks = flexMyPicks();
  const enPicks = flex.enemy.map(e => ({ key: e.key, role: e.role }));
  const my = teamProfile(myPicks), en = teamProfile(enPicks);
  if (my.n < 2 || en.n < 2) {
    el.innerHTML = `<div class="gp-empty">Draft outlook, win conditions and the matchup plan appear once your team and the enemy each have at least 2 champions.</div>`;
    return;
  }
  const partial = (my.n < 5 || en.n < 5) ? `<div class="gp-note">Draft in progress — the outlook and plan sharpen as more picks lock in.</div>` : "";
  el.innerHTML = partial
    + outlookHTML(myPicks, enPicks, "YOUR TEAM", "ENEMY", "var(--gold)", "var(--red-team)")
    + winConColsHTML(my, en, "var(--red-team)")
    + `<div class="gp-lbl">How to play it</div>
       <ul class="gp-list">${gamePlanBullets(myPicks, enPicks, my, en).map(t => `<li>${t}</li>`).join("")}</ul>`;
}

function renderFlexGrid() {
  const grid = $("flex-grid");
  grid.innerHTML = "";
  const used = flexUsed();
  const q = norm(flex.search);
  // champions in any player's pool, for a subtle highlight
  const inPool = new Set();
  PLAYERS.forEach(p => p.pool.forEach(e => inPool.add(e.key)));
  Object.keys(CHAMPIONS).sort((a, b) => dispName(a).localeCompare(dispName(b))).forEach(k => {
    const c = CHAMPIONS[k];
    if (q && !norm(dispName(k)).includes(q) && !norm(k).includes(q)) return;
    if (flex.gridRole !== "all" && !c.roles[flex.gridRole] && !(c.flex || []).includes(flex.gridRole)) return;
    const cell = document.createElement("div");
    cell.className = "champ-cell" + (used.has(k) ? " used" : "");
    cell.innerHTML = champImgHTML(k) + `<span>${dispName(k)}</span>`;
    cell.onclick = () => {
      if (used.has(k)) return;
      if (flex.addSide === "enemy") {
        if (flex.enemy.length >= 5) return;
        flex.enemy.push({ key: k, role: flexInferEnemyRole(k) });
      } else {
        // add to your team: place in the role of a player who has it, else its best role
        let placed = false;
        for (const r of ROLES) {
          const pl = PLAYERS[PLAYER_BY_ROLE[r]];
          if (!flex.mine[r] && pl.pool.some(e => e.key === k && (e.alt || r) === r)) { flex.mine[r] = k; placed = true; break; }
        }
        if (!placed) {
          const r = flexInferEnemyRole(k); // reuse best-open-role logic against your team
          const openMine = ROLES.filter(rr => !flex.mine[rr]);
          const target = openMine.includes(r) ? r : openMine[0];
          if (target) flex.mine[target] = k;
        }
      }
      renderFlex();
    };
    grid.appendChild(cell);
  });
}

function renderFlex() {
  renderFlexMine();
  renderFlexEnemy();
  renderFlexGamePlan();
  renderFlexGrid();
}

function setMode(mode) {
  document.body.classList.toggle("mode-flex", mode === "flex");
  document.body.classList.toggle("mode-draft", mode === "draft");
  $("tab-draft").classList.toggle("active", mode === "draft");
  $("tab-flex").classList.toggle("active", mode === "flex");
  if (mode === "flex") renderFlex(); else render();
}

/* flex wiring */
$("tab-draft").onclick = () => setMode("draft");
$("tab-flex").onclick = () => setMode("flex");
$("flex-reset-btn").onclick = () => {
  flex.mine = { top:null, jungle:null, mid:null, adc:null, support:null };
  flex.enemy = [];
  renderFlex();
};
$("flex-add-enemy").onclick = () => { flex.addSide = "enemy"; $("flex-add-enemy").classList.add("active"); $("flex-add-mine").classList.remove("active"); };
$("flex-add-mine").onclick = () => { flex.addSide = "mine"; $("flex-add-mine").classList.add("active"); $("flex-add-enemy").classList.remove("active"); };
$("flex-search").oninput = e => { flex.search = e.target.value; renderFlexGrid(); };
document.querySelectorAll("#flex-role-filters button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#flex-role-filters button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    flex.gridRole = b.dataset.role;
    renderFlexGrid();
  };
});

setMode("draft");
render();
