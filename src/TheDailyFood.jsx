import { useState, useEffect, useCallback, useRef } from "react";

// ── Build version ─────────────────────────────────────────────────────────────
// Bump this on every deploy. It renders on the select screen footer so you can
// confirm at a glance which build a given device is actually running. If two
// devices show different versions, the older one is on a stale service-worker
// cache — see the SW update logic in the root component.
const APP_VERSION = "3c.1";

// ── Apps Script sync ──────────────────────────────────────────────────────────
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyBzPgoUmbPCqk6Md7NDvvzgH2m9yAzn38_cQGdVzMZEk8BJ99wUkREQBUumtbR831g8A/exec";

async function postFireForget(action, body) {
  if (!APPS_SCRIPT_URL) return;
  try {
    await fetch(APPS_SCRIPT_URL + `?action=${action}`, {
      method:"POST", mode:"no-cors",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body),
    });
  } catch(e) { console.warn(`sync ${action}:`, e); }
}

// ── Profile writes: look vs stats ────────────────────────────────────────────
// These were previously a single "profile" POST that carried the whole row.
// Because the backend upsert replaces the row wholesale, any writer that
// omitted a field reset that field to its default — so every meal log wiped
// the child's outfit back to "none". The two concerns are now separate
// endpoints, and the backend field-merges, so an omitted field means
// "unchanged" rather than "reset".
//
// postProfileLook  — identity and appearance. Only sent when the user
//                    deliberately changes something, or to seed a new profile.
// postProfileStats — level and totalXp. Sent from every XP recalculation.
//                    Physically cannot touch appearance.

function postProfileLook(u) {
  postFireForget("profile", {
    userId:        u.id,
    name:          u.name,
    animal:        u.animal        || "cat",
    themeId:       u.themeId       || "teal",
    animalColorId: u.animalColorId || "mint",
    outfitId:      u.outfitId      || "none",
    parentPin:     u.parentPin     || "",
  });
}

function postProfileStats(u, totalXp, level) {
  postFireForget("profile_stats", {
    userId:  u.id,
    level:   level   ?? u.level   ?? 1,
    totalXp: totalXp ?? u.totalXp ?? 0,
  });
}

// Photo upload — returns the Drive file ID. Must be cors mode to read response.
async function uploadPhoto(userId, kind, refId, dataB64, mimeType) {
  if (!APPS_SCRIPT_URL) return null;
  try {
    const res = await fetch(APPS_SCRIPT_URL + "?action=photo", {
      method:"POST",
      headers:{"Content-Type":"text/plain;charset=utf-8"}, // avoid CORS preflight
      body:JSON.stringify({ userId, kind, refId, dataB64, mimeType:mimeType||"image/jpeg" }),
    });
    const j = await res.json();
    return j.status === "ok" ? j.data.photoId : null;
  } catch(e) { console.warn("uploadPhoto:", e); return null; }
}

async function bulkFetch(todayStr, weekStartStr) {
  if (!APPS_SCRIPT_URL) return null;
  try {
    const res = await fetch(APPS_SCRIPT_URL + `?action=bulk&today=${todayStr}&weekStart=${weekStartStr}`);
    const j   = await res.json();
    return j.status === "ok" ? j.data : null;
  } catch(e) { console.warn("bulkFetch:", e); return null; }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split("T")[0];

function isoDateAddDays(isoStr, days) {
  const d = new Date(isoStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// Monday-anchored week start
function mondayOf(isoStr) {
  const d = new Date(isoStr + "T12:00:00");
  const dow = (d.getDay() + 6) % 7; // 0 = Mon
  d.setDate(d.getDate() - dow);
  return d.toISOString().split("T")[0];
}

function daysOfWeek(weekStartIso) {
  return [...Array(7)].map((_,i) => isoDateAddDays(weekStartIso, i));
}

function friendlyDate(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-GB",
    { weekday:"short", day:"numeric", month:"short" });
}

// ── Photo handling ────────────────────────────────────────────────────────────
// Compress to ~600px max dimension, JPEG quality 0.72
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => {
      img.onload = () => {
        const max = 600;
        let w = img.width, h = img.height;
        if (w > h && w > max) { h = h * (max/w); w = max; }
        else if (h > max)     { w = w * (max/h); h = max; }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const b64 = canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
        resolve({ dataB64: b64, mimeType:"image/jpeg" });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Drive file ID → directly viewable image URL
function photoUrl(photoId) {
  if (!photoId) return null;
  return `https://drive.google.com/thumbnail?id=${photoId}&sz=w800`;
}

// ── XP & level math ───────────────────────────────────────────────────────────
const XP_RATING    = { all: 10, most: 6, barely: 2 };
const XP_PHOTO     = 2;
const XP_NEW_FOOD  = 25;
const XP_SNACK     = 3;
const XP_PERFECT_DAY = 15;

// Level 1 starts at 0 XP. Level N → N+1 needs (25 + 25*N) XP.
// Cumulative XP at start of Level N = 12.5 * (N-1) * (N+2)
//   L1=0, L2=50, L3=125, L4=225, L5=350, L6=500, L7=675, L8=875, L9=1100, L10=1350...
function xpForLevel(n) { return Math.round(12.5 * (n - 1) * (n + 2)); }
function levelFromXp(xp) {
  let n = 1;
  while (xpForLevel(n + 1) <= xp) n++;
  return n;
}
function xpProgressInLevel(xp) {
  const lvl   = levelFromXp(xp);
  const start = xpForLevel(lvl);
  const next  = xpForLevel(lvl + 1);
  return { lvl, current: xp - start, needed: next - start, pct: (xp - start) / (next - start) };
}

// Compute XP for a single log entry
function calcLogXp({ rating, wasNew, hasPhoto, slot }) {
  if (slot === "snack") {
    return XP_SNACK + (wasNew ? XP_NEW_FOOD : 0) + (hasPhoto ? XP_PHOTO : 0);
  }
  return (XP_RATING[rating] || 0) + (wasNew ? XP_NEW_FOOD : 0) + (hasPhoto ? XP_PHOTO : 0);
}

// ── Constants — themes & animals (ported from Daily Drink) ───────────────────
const THEME_COLOURS = [
  { id:"teal",    label:"Teal",    accent:"#2AA89A", light:"#E6F8F6", dark:"#1A7A6E" },
  { id:"coral",   label:"Coral",   accent:"#E07050", light:"#FFF0EA", dark:"#A84C30" },
  { id:"indigo",  label:"Indigo",  accent:"#5C6BC0", light:"#EDEFFE", dark:"#3949AB" },
  { id:"rose",    label:"Rose",    accent:"#E05C8A", light:"#FFEEF5", dark:"#B03468" },
  { id:"amber",   label:"Amber",   accent:"#D97706", light:"#FFF8E7", dark:"#92540A" },
  { id:"emerald", label:"Emerald", accent:"#059669", light:"#ECFDF5", dark:"#065F46" },
  { id:"purple",  label:"Purple",  accent:"#7C3AED", light:"#F3EEFF", dark:"#5B21B6" },
  { id:"sky",     label:"Sky",     accent:"#0284C7", light:"#E0F4FF", dark:"#075985" },
  { id:"pink",    label:"Pink",    accent:"#DB2777", light:"#FDF0F7", dark:"#9D174D" },
  { id:"lime",    label:"Lime",    accent:"#65A30D", light:"#F2FBEA", dark:"#3F6212" },
];

const ANIMAL_COLOURS = [
  { id:"mint",      label:"Mint",      color:"#52C4B5" },
  { id:"peach",     label:"Peach",     color:"#F4916A" },
  { id:"lavender",  label:"Lavender",  color:"#9B7FD4" },
  { id:"sky",       label:"Sky",       color:"#56ADEF" },
  { id:"rose",      label:"Rose",      color:"#F06EA0" },
  { id:"gold",      label:"Gold",      color:"#F5C842" },
  { id:"sage",      label:"Sage",      color:"#7DBD8A" },
  { id:"tangerine", label:"Tangerine", color:"#F4A23A" },
  { id:"lilac",     label:"Lilac",     color:"#C3A0E0" },
  { id:"crimson",   label:"Crimson",   color:"#E05555" },
];

const ANIMALS = [
  { id:"cat",     label:"Cat",     emoji:"🐱" },
  { id:"dog",     label:"Dog",     emoji:"🐶" },
  { id:"unicorn", label:"Unicorn", emoji:"🦄" },
  // fish and rabbit removed — existing data silently falls back to cat
];

const BODY_RATIO = 1.85; // AnimalBody SVG height = size * BODY_RATIO; head stays at cy=size/2

const DEFAULT_USERS = [
  { id:"skylar", name:"Skylar", animal:"cat", themeId:"teal",  animalColorId:"mint",  level:1, totalXp:0 },
  { id:"caia",   name:"Caia",   animal:"cat", themeId:"coral", animalColorId:"peach", level:1, totalXp:0 },
];

const SLOTS = [
  { id:"breakfast", label:"Breakfast", emoji:"🌅" },
  { id:"lunch",     label:"Lunch",     emoji:"☀️" },
  { id:"dinner",    label:"Dinner",    emoji:"🌙" },
];

const CATEGORIES = [
  { id:"breakfast", label:"Breakfast" },
  { id:"lunch",     label:"Lunch"     },
  { id:"dinner",    label:"Dinner"    },
  { id:"snack",     label:"Snack"     },
  { id:"any",       label:"Anytime"   },
];

const FOOD_EMOJIS = ["🍞","🥐","🥞","🧇","🥯","🥖","🥪","🥗","🌮","🌯","🥙","🍕","🍝","🍜","🍲","🍛","🍱","🍣","🍙","🍚","🥘","🍳","🥚","🥓","🍔","🌭","🍟","🥩","🍗","🍖","🦴","🍤","🦐","🦞","🦀","🦑","🐟","🐠","🥟","🥠","🍢","🍡","🍧","🍨","🍦","🥮","🍰","🎂","🧁","🍮","🍯","🍪","🍩","🍫","🍬","🍭","🍿","🥜","🌰","🥥","🥝","🍓","🫐","🍇","🍉","🍊","🍋","🍌","🍍","🥭","🍎","🍏","🍐","🍑","🍒","🥑","🍅","🍆","🥒","🥬","🥦","🌽","🥕","🌶️","🫑","🥔","🍠","🧄","🧅","🍄","🥯","🧀","🍶","🥛","☕","🧃","🧋","🥤","🧉"];

const RATINGS = [
  { id:"all",    label:"All gone!",  emoji:"🌟", desc:"Finished it all" },
  { id:"most",   label:"Most of it", emoji:"👍", desc:"Ate most of it" },
  { id:"barely", label:"Barely",     emoji:"🥲", desc:"Hardly any" },
];

const resolveTheme  = id => THEME_COLOURS.find(t=>t.id===id)  || THEME_COLOURS[0];
const resolveAnimal = id => ANIMAL_COLOURS.find(c=>c.id===id) || ANIMAL_COLOURS[0];
const userTheme     = u  => resolveTheme(u.themeId);
const userAColor    = u  => resolveAnimal(u.animalColorId).color;

// ── Animal faces (ported verbatim from Daily Drink — same SVG, same emotional states) ──
function CatFace({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{overflow:"visible"}}>
      {happy&&<circle cx={cx} cy={cy+5} r={s*.38} fill={color} opacity=".18"/>}
      <ellipse cx={cx} cy={cy+14} rx={s*.32} ry={s*.26} fill={color} opacity=".25"/>
      <ellipse cx={cx} cy={cy} rx={s*.36} ry={s*.33} fill={color}/>
      <polygon points={`${cx-s*.3},${cy-s*.25} ${cx-s*.38},${cy-s*.46} ${cx-s*.14},${cy-s*.32}`} fill={color}/>
      <polygon points={`${cx+s*.3},${cy-s*.25} ${cx+s*.38},${cy-s*.46} ${cx+s*.14},${cy-s*.32}`} fill={color}/>
      <polygon points={`${cx-s*.28},${cy-s*.27} ${cx-s*.35},${cy-s*.42} ${cx-s*.17},${cy-s*.31}`} fill="white" opacity=".45"/>
      <polygon points={`${cx+s*.28},${cy-s*.27} ${cx+s*.35},${cy-s*.42} ${cx+s*.17},${cy-s*.31}`} fill="white" opacity=".45"/>
      {sad?[cx-s*.14,cx+s*.14].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.06} x2={ex+s*.06} y2={cy+s*.06} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.06} x2={ex-s*.06} y2={cy+s*.06} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.22} ${cy} Q${cx-s*.14} ${cy-s*.1} ${cx-s*.06} ${cy}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy} Q${cx+s*.14} ${cy-s*.1} ${cx+s*.22} ${cy}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/></>
      :<><ellipse cx={cx-s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><ellipse cx={cx+s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><circle cx={cx-s*.11} cy={cy-s*.04} r={s*.025} fill="white"/><circle cx={cx+s*.17} cy={cy-s*.04} r={s*.025} fill="white"/></>}
      <ellipse cx={cx} cy={cy+s*.1} rx={s*.04} ry={s*.03} fill="#FFAAB5"/>
      <line x1={cx} y1={cy+s*.13} x2={cx} y2={cy+s*.16} stroke="#FFAAB5" strokeWidth="1.5"/>
      {sad?<path d={`M${cx-s*.1} ${cy+s*.22} Q${cx} ${cy+s*.17} ${cx+s*.1} ${cy+s*.22}`} stroke="#555" strokeWidth="2" fill="none" strokeLinecap="round"/>:happy?<path d={`M${cx-s*.1} ${cy+s*.16} Q${cx} ${cy+s*.25} ${cx+s*.1} ${cy+s*.16}`} stroke="#555" strokeWidth="2" fill="none" strokeLinecap="round"/>:<path d={`M${cx-s*.07} ${cy+s*.18} Q${cx} ${cy+s*.21} ${cx+s*.07} ${cy+s*.18}`} stroke="#555" strokeWidth="1.8" fill="none" strokeLinecap="round"/>}
      {[[-1,-.06],[-1,.03],[1,-.06],[1,.03]].map(([dir,dy],i)=>(<line key={i} x1={cx+dir*(s*.06)} y1={cy+s*dy+s*.11} x2={cx+dir*(s*.38)} y2={cy+s*dy+s*.09+(dir===-1?-s*.015:s*.015)} stroke="#aaa" strokeWidth="1.2" strokeLinecap="round" opacity=".6"/>))}
      {(happy||okay)&&<><ellipse cx={cx-s*.27} cy={cy+s*.06} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.25}/><ellipse cx={cx+s*.27} cy={cy+s*.06} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.25}/></>}
      {happy&&<><text x={cx-s*.48} y={cy-s*.3} fontSize={s*.18}>✨</text><text x={cx+s*.32} y={cy-s*.32} fontSize={s*.16}>🍎</text></>}
      {sad&&<text x={cx-s*.05} y={cy+s*.52} fontSize={s*.16}>😋</text>}
    </svg>
  );
}

function DogFace({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{overflow:"visible"}}>
      {happy&&<circle cx={cx} cy={cy} r={s*.42} fill={color} opacity=".15"/>}
      <ellipse cx={cx-s*.34} cy={cy+s*.08} rx={s*.14} ry={s*.28} fill={color} opacity=".85" transform={`rotate(-12,${cx-s*.34},${cy+s*.08})`}/>
      <ellipse cx={cx+s*.34} cy={cy+s*.08} rx={s*.14} ry={s*.28} fill={color} opacity=".85" transform={`rotate(12,${cx+s*.34},${cy+s*.08})`}/>
      <ellipse cx={cx} cy={cy-s*.02} rx={s*.34} ry={s*.31} fill={color}/>
      <ellipse cx={cx} cy={cy+s*.14} rx={s*.18} ry={s*.13} fill="white" opacity=".6"/>
      <ellipse cx={cx} cy={cy+s*.08} rx={s*.07} ry={s*.05} fill="#333"/>
      <circle cx={cx-s*.025} cy={cy+s*.065} r={s*.018} fill="white" opacity=".7"/>
      {sad?[cx-s*.15,cx+s*.15].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.08} x2={ex+s*.06} y2={cy-s*.01} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.08} x2={ex-s*.06} y2={cy-s*.01} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.2} ${cy-s*.06} Q${cx-s*.13} ${cy-s*.14} ${cx-s*.06} ${cy-s*.06}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy-s*.06} Q${cx+s*.13} ${cy-s*.14} ${cx+s*.2} ${cy-s*.06}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/></>
      :<><ellipse cx={cx-s*.15} cy={cy-s*.07} rx={s*.065} ry={s*.07} fill="#333"/><ellipse cx={cx+s*.15} cy={cy-s*.07} rx={s*.065} ry={s*.07} fill="#333"/><circle cx={cx-s*.12} cy={cy-s*.1} r={s*.022} fill="white"/><circle cx={cx+s*.18} cy={cy-s*.1} r={s*.022} fill="white"/></>}
      {sad?<path d={`M${cx-s*.1} ${cy+s*.24} Q${cx} ${cy+s*.2} ${cx+s*.1} ${cy+s*.24}`} stroke="#888" strokeWidth="2" fill="none" strokeLinecap="round"/>:happy?<><path d={`M${cx-s*.1} ${cy+s*.18} Q${cx} ${cy+s*.27} ${cx+s*.1} ${cy+s*.18}`} stroke="#E07070" strokeWidth="2.5" fill="none" strokeLinecap="round"/><ellipse cx={cx} cy={cy+s*.22} rx={s*.07} ry={s*.04} fill="#FF9090" opacity=".5"/></>:<path d={`M${cx-s*.08} ${cy+s*.2} Q${cx} ${cy+s*.24} ${cx+s*.08} ${cy+s*.2}`} stroke="#888" strokeWidth="1.8" fill="none" strokeLinecap="round"/>}
      {(happy||okay)&&<><ellipse cx={cx-s*.3} cy={cy+s*.04} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.2}/><ellipse cx={cx+s*.3} cy={cy+s*.04} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.2}/></>}
      {happy&&<text x={cx-s*.08} y={cy-s*.42} fontSize={s*.22}>🍖</text>}
      {sad&&<text x={cx-s*.05} y={cy+s*.54} fontSize={s*.16}>😋</text>}
    </svg>
  );
}

function FishFace({ pct, color, size=118 }) {
  const happy=pct>=0.8, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2;
  const bubbles=happy?[{x:cx+s*.38,y:cy-s*.28,r:s*.04},{x:cx+s*.48,y:cy-s*.42,r:s*.028},{x:cx+s*.42,y:cy-s*.54,r:s*.02}]:[];
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{overflow:"visible"}}>
      {happy&&<ellipse cx={cx} cy={cy} rx={s*.48} ry={s*.38} fill={color} opacity=".12"/>}
      <polygon points={`${cx+s*.3},${cy} ${cx+s*.54},${cy-s*.28} ${cx+s*.54},${cy+s*.28}`} fill={color} opacity=".7"/>
      <ellipse cx={cx-s*.04} cy={cy} rx={s*.38} ry={s*.28} fill={color}/>
      <ellipse cx={cx-s*.06} cy={cy+s*.06} rx={s*.26} ry={s*.16} fill="white" opacity=".35"/>
      <path d={`M${cx-s*.1} ${cy-s*.28} Q${cx+s*.06} ${cy-s*.44} ${cx+s*.14} ${cy-s*.18}`} fill={color} opacity=".8"/>
      <circle cx={cx-s*.22} cy={cy-s*.06} r={s*.1} fill="white"/>
      {sad?<><line x1={cx-s*.28} y1={cy-s*.1} x2={cx-s*.16} y2={cy-s*.02} stroke="#444" strokeWidth="2" strokeLinecap="round"/><line x1={cx-s*.16} y1={cy-s*.1} x2={cx-s*.28} y2={cy-s*.02} stroke="#444" strokeWidth="2" strokeLinecap="round"/></>:happy?<path d={`M${cx-s*.3} ${cy-s*.06} Q${cx-s*.22} ${cy-s*.16} ${cx-s*.14} ${cy-s*.06}`} stroke="#333" strokeWidth="2.2" fill="none" strokeLinecap="round"/>:<><ellipse cx={cx-s*.22} cy={cy-s*.06} rx={s*.055} ry={s*.065} fill="#222"/><circle cx={cx-s*.2} cy={cy-s*.09} r={s*.02} fill="white"/></>}
      {sad?<path d={`M${cx-s*.38} ${cy+s*.1} Q${cx-s*.34} ${cy+s*.06} ${cx-s*.3} ${cy+s*.1}`} stroke="#888" strokeWidth="1.8" fill="none" strokeLinecap="round"/>:happy?<path d={`M${cx-s*.38} ${cy+s*.06} Q${cx-s*.34} ${cy+s*.13} ${cx-s*.3} ${cy+s*.06}`} stroke="#555" strokeWidth="1.8" fill="none" strokeLinecap="round"/>:<circle cx={cx-s*.34} cy={cy+s*.08} r={s*.025} fill="#888"/>}
      {[[0,.08],[-.1,.02],[.1,.02],[-.05,-.08],[.05,-.08]].map(([dx,dy],i)=>(<ellipse key={i} cx={cx+dx*s} cy={cy+dy*s} rx={s*.06} ry={s*.04} fill="none" stroke="white" strokeWidth="1" opacity=".3"/>))}
      {bubbles.map((b,i)=><circle key={i} cx={b.x} cy={b.y} r={b.r} fill="none" stroke={color} strokeWidth="1.5" opacity=".7"/>)}
      {sad&&<text x={cx-s*.5} y={cy+s*.52} fontSize={s*.16}>🍱</text>}
    </svg>
  );
}

function UnicornFace({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{overflow:"visible"}}>
      {happy&&<circle cx={cx} cy={cy+s*.05} r={s*.42} fill={color} opacity=".15"/>}
      <ellipse cx={cx+s*.34} cy={cy-s*.18} rx={s*.1} ry={s*.2} fill="#C084FC" transform={`rotate(20,${cx+s*.34},${cy-s*.18})`}/>
      <ellipse cx={cx+s*.28} cy={cy-s*.24} rx={s*.09} ry={s*.18} fill="#F472B6" transform={`rotate(10,${cx+s*.28},${cy-s*.24})`}/>
      <ellipse cx={cx+s*.22} cy={cy-s*.27} rx={s*.08} ry={s*.16} fill="#818CF8"/>
      {happy&&<ellipse cx={cx+s*.15} cy={cy-s*.29} rx={s*.07} ry={s*.14} fill="#34D399" transform={`rotate(-8,${cx+s*.15},${cy-s*.29})`}/>}
      <polygon points={`${cx},${cy-s*.52} ${cx-s*.06},${cy-s*.28} ${cx+s*.06},${cy-s*.28}`} fill="#FCD34D"/>
      <line x1={cx} y1={cy-s*.5} x2={cx-s*.02} y2={cy-s*.3} stroke="#F59E0B" strokeWidth="1.2" opacity=".55"/>
      <polygon points={`${cx-s*.3},${cy-s*.22} ${cx-s*.38},${cy-s*.46} ${cx-s*.16},${cy-s*.3}`} fill={color}/>
      <polygon points={`${cx-s*.29},${cy-s*.24} ${cx-s*.35},${cy-s*.42} ${cx-s*.19},${cy-s*.31}`} fill="white" opacity=".45"/>
      <ellipse cx={cx} cy={cy+s*.04} rx={s*.35} ry={s*.32} fill={color}/>
      <ellipse cx={cx} cy={cy+s*.18} rx={s*.19} ry={s*.13} fill="white" opacity=".5"/>
      <circle cx={cx-s*.07} cy={cy+s*.19} r={s*.03} fill="#FDA4AF" opacity=".8"/>
      <circle cx={cx+s*.07} cy={cy+s*.19} r={s*.03} fill="#FDA4AF" opacity=".8"/>
      {sad?[cx-s*.14,cx+s*.14].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.04} x2={ex+s*.06} y2={cy+s*.03} stroke="#444" strokeWidth="2.4" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.04} x2={ex-s*.06} y2={cy+s*.03} stroke="#444" strokeWidth="2.4" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.22} ${cy} Q${cx-s*.14} ${cy-s*.1} ${cx-s*.06} ${cy}`} stroke="#333" strokeWidth="2.4" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy} Q${cx+s*.14} ${cy-s*.1} ${cx+s*.22} ${cy}`} stroke="#333" strokeWidth="2.4" fill="none" strokeLinecap="round"/></>
      :<><ellipse cx={cx-s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><ellipse cx={cx+s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><circle cx={cx-s*.11} cy={cy-s*.04} r={s*.025} fill="white"/><circle cx={cx+s*.17} cy={cy-s*.04} r={s*.025} fill="white"/></>}
      {sad?<path d={`M${cx-s*.1} ${cy+s*.27} Q${cx} ${cy+s*.22} ${cx+s*.1} ${cy+s*.27}`} stroke="#888" strokeWidth="1.8" fill="none" strokeLinecap="round"/>:<path d={`M${cx-s*.1} ${cy+s*.22} Q${cx} ${cy+s*.3} ${cx+s*.1} ${cy+s*.22}`} stroke="#888" strokeWidth={happy?"2.2":"1.8"} fill="none" strokeLinecap="round"/>}
      {(happy||okay)&&<><ellipse cx={cx-s*.28} cy={cy+s*.1} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.55:.25}/><ellipse cx={cx+s*.28} cy={cy+s*.1} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.55:.25}/></>}
      {happy&&<><text x={cx-s*.52} y={cy-s*.28} fontSize={s*.18}>✨</text><text x={cx+s*.34} y={cy-s*.3} fontSize={s*.15}>🍰</text></>}
      {sad&&<text x={cx-s*.05} y={cy+s*.56} fontSize={s*.16}>😋</text>}
    </svg>
  );
}

function RabbitFace({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{overflow:"visible"}}>
      {happy&&<circle cx={cx} cy={cy+s*.05} r={s*.42} fill={color} opacity=".15"/>}
      <ellipse cx={cx-s*.2} cy={cy-s*.42} rx={s*.1} ry={s*.26} fill={color}/>
      <ellipse cx={cx+s*.2} cy={cy-s*.42} rx={s*.1} ry={s*.26} fill={color}/>
      <ellipse cx={cx-s*.2} cy={cy-s*.42} rx={s*.055} ry={s*.2} fill="#FFCDD2" opacity=".7"/>
      <ellipse cx={cx+s*.2} cy={cy-s*.42} rx={s*.055} ry={s*.2} fill="#FFCDD2" opacity=".7"/>
      <ellipse cx={cx} cy={cy+s*.04} rx={s*.35} ry={s*.32} fill={color}/>
      <ellipse cx={cx-s*.28} cy={cy+s*.12} rx={s*.13} ry={s*.1} fill="white" opacity=".3"/>
      <ellipse cx={cx+s*.28} cy={cy+s*.12} rx={s*.13} ry={s*.1} fill="white" opacity=".3"/>
      <ellipse cx={cx} cy={cy+s*.1} rx={s*.04} ry={s*.03} fill="#FFAAB5"/>
      <line x1={cx} y1={cy+s*.13} x2={cx} y2={cy+s*.16} stroke="#FFAAB5" strokeWidth="1.4"/>
      {sad?[cx-s*.14,cx+s*.14].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.04} x2={ex+s*.06} y2={cy+s*.03} stroke="#444" strokeWidth="2.4" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.04} x2={ex-s*.06} y2={cy+s*.03} stroke="#444" strokeWidth="2.4" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.22} ${cy} Q${cx-s*.14} ${cy-s*.1} ${cx-s*.06} ${cy}`} stroke="#333" strokeWidth="2.4" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy} Q${cx+s*.14} ${cy-s*.1} ${cx+s*.22} ${cy}`} stroke="#333" strokeWidth="2.4" fill="none" strokeLinecap="round"/></>
      :<><circle cx={cx-s*.14} cy={cy-s*.01} r={s*.07} fill="#555"/><circle cx={cx+s*.14} cy={cy-s*.01} r={s*.07} fill="#555"/><circle cx={cx-s*.11} cy={cy-s*.04} r={s*.024} fill="white"/><circle cx={cx+s*.17} cy={cy-s*.04} r={s*.024} fill="white"/></>}
      {sad?<path d={`M${cx-s*.1} ${cy+s*.22} Q${cx} ${cy+s*.17} ${cx+s*.1} ${cy+s*.22}`} stroke="#888" strokeWidth="1.8" fill="none" strokeLinecap="round"/>:<path d={`M${cx-s*.1} ${cy+s*.18} Q${cx} ${cy+s*.26} ${cx+s*.1} ${cy+s*.18}`} stroke="#888" strokeWidth={happy?"2.2":"1.8"} fill="none" strokeLinecap="round"/>}
      {(happy||okay)&&<><ellipse cx={cx-s*.28} cy={cy+s*.1} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.25}/><ellipse cx={cx+s*.28} cy={cy+s*.1} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.25}/></>}
      {happy&&<><text x={cx-s*.52} y={cy-s*.28} fontSize={s*.18}>✨</text><text x={cx+s*.34} y={cy-s*.3} fontSize={s*.15}>🥕</text></>}
      {sad&&<text x={cx-s*.05} y={cy+s*.56} fontSize={s*.16}>😋</text>}
    </svg>
  );
}

function AnimalFace({ animal, pct, color, size=118, outfit }) {
  const face = (() => {
    switch(animal) {
      case "dog":     return <DogFace     pct={pct} color={color} size={size}/>;
      case "unicorn": return <UnicornFace pct={pct} color={color} size={size}/>;
      // fish and rabbit fall through to cat — backward compat for stored data
      default:        return <CatFace     pct={pct} color={color} size={size}/>;
    }
  })();

  if (!outfit || outfit === "none") return face;

  return (
    <div style={{ position:"relative", display:"inline-block", width:size, height:size, lineHeight:0 }}>
      {face}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ position:"absolute", top:0, left:0, pointerEvents:"none", overflow:"visible" }}>
        <OutfitGraphic id={outfit} cx={size/2} cy={size/2} s={size}/>
      </svg>
    </div>
  );
}

// ── Full-body animal components ───────────────────────────────────────────────
// Used in LiveAnimal (Today screen + Island) and the eating/level-up overlays.
// Head stays at (cx=size/2, cy=size/2) — identical to the face components so
// outfit overlays remain aligned. Body extends into the lower BODY_RATIO area.
// AnimalFace is kept for small-context renders (select cards, settings, outfit
// picker) where detail below 66px isn't meaningful.

function CatBody({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2, H=s*BODY_RATIO;
  const tailBaseX=cx+s*0.24, tailBaseY=s*1.22;
  // Shoulder pivot points — at torso edge, y=s*0.9
  const rSx=cx+s*0.24, lSx=cx-s*0.24, sY=s*0.9;
  const rAnim = sad ? undefined : happy ? "waveArmRight 2.4s ease-in-out infinite" : "idleArmRight 4s ease-in-out infinite";
  const lAnim = sad ? undefined : happy ? "waveArmLeft 2.8s ease-in-out infinite 0.6s" : "idleArmLeft 4.5s ease-in-out infinite 1s";
  return (
    <svg width={s} height={H} viewBox={`0 0 ${s} ${H}`} style={{overflow:"visible", display:"block"}}>
      {/* ── BODY ── */}
      <rect x={cx-s*0.09} y={cy+s*0.32} width={s*0.18} height={s*0.2} rx={s*0.06} fill={color}/>
      <ellipse cx={cx} cy={s*1.05} rx={s*0.28} ry={s*0.3} fill={color}/>
      <ellipse cx={cx} cy={s*1.08} rx={s*0.14} ry={s*0.18} fill="white" opacity="0.25"/>
      {/* Shoulder joints */}
      <circle cx={lSx} cy={sY} r={s*0.065} fill={color}/>
      <circle cx={rSx} cy={sY} r={s*0.065} fill={color}/>
      {/* Left arm */}
      <g style={sad ? { transform:`rotate(-55deg)`, transformOrigin:`${lSx}px ${sY}px` } : { animation:lAnim, transformOrigin:`${lSx}px ${sY}px` }}>
        <rect x={cx-s*0.46} y={sY-s*0.048} width={s*0.22} height={s*0.1} rx={s*0.05} fill={color}/>
        <ellipse cx={cx-s*0.49} cy={sY+s*0.005} rx={s*0.065} ry={s*0.055} fill={color}/>
        {/* Toe nubs on paw */}
        <circle cx={cx-s*0.51} cy={sY-s*0.04} r={s*0.018} fill="white" opacity="0.4"/>
        <circle cx={cx-s*0.495} cy={sY-s*0.05} r={s*0.015} fill="white" opacity="0.4"/>
      </g>
      {/* Right arm */}
      <g style={sad ? { transform:`rotate(55deg)`, transformOrigin:`${rSx}px ${sY}px` } : { animation:rAnim, transformOrigin:`${rSx}px ${sY}px` }}>
        <rect x={cx+s*0.24} y={sY-s*0.048} width={s*0.22} height={s*0.1} rx={s*0.05} fill={color}/>
        <ellipse cx={cx+s*0.49} cy={sY+s*0.005} rx={s*0.065} ry={s*0.055} fill={color}/>
        <circle cx={cx+s*0.505} cy={sY-s*0.04} r={s*0.018} fill="white" opacity="0.4"/>
        <circle cx={cx+s*0.49} cy={sY-s*0.05} r={s*0.015} fill="white" opacity="0.4"/>
      </g>
      {/* Front legs */}
      <rect x={cx-s*0.21} y={s*1.26} width={s*0.15} height={s*0.26} rx={s*0.075} fill={color}/>
      <rect x={cx+s*0.06} y={s*1.26} width={s*0.15} height={s*0.26} rx={s*0.075} fill={color}/>
      {/* Paws */}
      <ellipse cx={cx-s*0.135} cy={s*1.54} rx={s*0.1} ry={s*0.058} fill={color}/>
      <ellipse cx={cx+s*0.135} cy={s*1.54} rx={s*0.1} ry={s*0.058} fill={color}/>
      {[-s*0.195,-s*0.135,-s*0.075].map((dx,i)=>(<line key={i} x1={cx+dx} y1={s*1.51} x2={cx+dx} y2={s*1.57} stroke="white" strokeWidth={s*0.012} strokeLinecap="round" opacity="0.45"/>))}
      {[s*0.075, s*0.135, s*0.195].map((dx,i) =>(<line key={i} x1={cx+dx} y1={s*1.51} x2={cx+dx} y2={s*1.57} stroke="white" strokeWidth={s*0.012} strokeLinecap="round" opacity="0.45"/>))}
      {/* Tail */}
      <g style={{ animation:"catTailWag 2.2s ease-in-out infinite", transformOrigin:`${tailBaseX}px ${tailBaseY}px` }}>
        <path d={`M${tailBaseX},${tailBaseY} Q${cx+s*0.6},${s*1.06} ${cx+s*0.5},${s*0.62} Q${cx+s*0.42},${s*0.4} ${cx+s*0.52},${s*0.3}`}
          stroke={color} strokeWidth={s*0.1} fill="none" strokeLinecap="round"/>
        <circle cx={cx+s*0.52} cy={s*0.26} r={s*0.068} fill="white" opacity="0.65"/>
        <circle cx={cx+s*0.52} cy={s*0.26} r={s*0.04} fill={color} opacity="0.5"/>
      </g>
      {/* ── HEAD ── */}
      {happy&&<circle cx={cx} cy={cy+5} r={s*.38} fill={color} opacity=".18"/>}
      <ellipse cx={cx} cy={cy+s*0.14} rx={s*.32} ry={s*.26} fill={color} opacity=".25"/>
      <ellipse cx={cx} cy={cy} rx={s*.36} ry={s*.33} fill={color}/>
      <polygon points={`${cx-s*.3},${cy-s*.25} ${cx-s*.38},${cy-s*.46} ${cx-s*.14},${cy-s*.32}`} fill={color}/>
      <polygon points={`${cx+s*.3},${cy-s*.25} ${cx+s*.38},${cy-s*.46} ${cx+s*.14},${cy-s*.32}`} fill={color}/>
      <polygon points={`${cx-s*.28},${cy-s*.27} ${cx-s*.35},${cy-s*.42} ${cx-s*.17},${cy-s*.31}`} fill="white" opacity=".45"/>
      <polygon points={`${cx+s*.28},${cy-s*.27} ${cx+s*.35},${cy-s*.42} ${cx+s*.17},${cy-s*.31}`} fill="white" opacity=".45"/>
      {sad?[cx-s*.14,cx+s*.14].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.06} x2={ex+s*.06} y2={cy+s*.06} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.06} x2={ex-s*.06} y2={cy+s*.06} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.22} ${cy} Q${cx-s*.14} ${cy-s*.1} ${cx-s*.06} ${cy}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy} Q${cx+s*.14} ${cy-s*.1} ${cx+s*.22} ${cy}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/></>
      :<><ellipse cx={cx-s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><ellipse cx={cx+s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><circle cx={cx-s*.11} cy={cy-s*.04} r={s*.025} fill="white"/><circle cx={cx+s*.17} cy={cy-s*.04} r={s*.025} fill="white"/></>}
      <ellipse cx={cx} cy={cy+s*.1} rx={s*.04} ry={s*.03} fill="#FFAAB5"/>
      <line x1={cx} y1={cy+s*.13} x2={cx} y2={cy+s*.16} stroke="#FFAAB5" strokeWidth="1.5"/>
      {sad?<path d={`M${cx-s*.1} ${cy+s*.22} Q${cx} ${cy+s*.17} ${cx+s*.1} ${cy+s*.22}`} stroke="#555" strokeWidth="2" fill="none" strokeLinecap="round"/>:happy?<path d={`M${cx-s*.1} ${cy+s*.16} Q${cx} ${cy+s*.25} ${cx+s*.1} ${cy+s*.16}`} stroke="#555" strokeWidth="2" fill="none" strokeLinecap="round"/>:<path d={`M${cx-s*.07} ${cy+s*.18} Q${cx} ${cy+s*.21} ${cx+s*.07} ${cy+s*.18}`} stroke="#555" strokeWidth="1.8" fill="none" strokeLinecap="round"/>}
      {[[-1,-.06],[-1,.03],[1,-.06],[1,.03]].map(([dir,dy],i)=>(<line key={i} x1={cx+dir*(s*.06)} y1={cy+s*dy+s*.11} x2={cx+dir*(s*.38)} y2={cy+s*dy+s*.09+(dir===-1?-s*.015:s*.015)} stroke="#aaa" strokeWidth="1.2" strokeLinecap="round" opacity=".6"/>))}
      {(happy||okay)&&<><ellipse cx={cx-s*.27} cy={cy+s*.06} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.25}/><ellipse cx={cx+s*.27} cy={cy+s*.06} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.25}/></>}
      {happy&&<><text x={cx-s*.48} y={cy-s*.3} fontSize={s*.18}>✨</text><text x={cx+s*.32} y={cy-s*.32} fontSize={s*.16}>🍎</text></>}
      {sad&&<text x={cx-s*.05} y={cy+s*.52} fontSize={s*.16}>😋</text>}
    </svg>
  );
}

function DogBody({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2, H=s*BODY_RATIO;
  const tailBaseX=cx+s*0.22, tailBaseY=s*1.2;
  const rSx=cx+s*0.25, lSx=cx-s*0.25, sY=s*0.9;
  const rAnim = sad ? undefined : happy ? "waveArmRight 2.2s ease-in-out infinite" : "idleArmRight 3.8s ease-in-out infinite";
  const lAnim = sad ? undefined : happy ? "waveArmLeft 2.6s ease-in-out infinite 0.5s" : "idleArmLeft 4.2s ease-in-out infinite 0.9s";
  return (
    <svg width={s} height={H} viewBox={`0 0 ${s} ${H}`} style={{overflow:"visible", display:"block"}}>
      {/* ── BODY ── */}
      <rect x={cx-s*0.1} y={cy+s*0.3} width={s*0.2} height={s*0.2} rx={s*0.07} fill={color}/>
      <ellipse cx={cx} cy={s*1.04} rx={s*0.3} ry={s*0.32} fill={color}/>
      <ellipse cx={cx} cy={s*1.08} rx={s*0.14} ry={s*0.17} fill="white" opacity="0.25"/>
      {/* Shoulder joints */}
      <circle cx={lSx} cy={sY} r={s*0.07} fill={color}/>
      <circle cx={rSx} cy={sY} r={s*0.07} fill={color}/>
      {/* Left arm */}
      <g style={sad ? { transform:`rotate(-55deg)`, transformOrigin:`${lSx}px ${sY}px` } : { animation:lAnim, transformOrigin:`${lSx}px ${sY}px` }}>
        <rect x={cx-s*0.49} y={sY-s*0.052} width={s*0.24} height={s*0.11} rx={s*0.055} fill={color}/>
        <ellipse cx={cx-s*0.525} cy={sY+s*0.005} rx={s*0.072} ry={s*0.06} fill={color}/>
        <circle cx={cx-s*0.545} cy={sY-s*0.04} r={s*0.02} fill="white" opacity="0.4"/>
        <circle cx={cx-s*0.53} cy={sY-s*0.055} r={s*0.016} fill="white" opacity="0.4"/>
      </g>
      {/* Right arm */}
      <g style={sad ? { transform:`rotate(55deg)`, transformOrigin:`${rSx}px ${sY}px` } : { animation:rAnim, transformOrigin:`${rSx}px ${sY}px` }}>
        <rect x={cx+s*0.25} y={sY-s*0.052} width={s*0.24} height={s*0.11} rx={s*0.055} fill={color}/>
        <ellipse cx={cx+s*0.525} cy={sY+s*0.005} rx={s*0.072} ry={s*0.06} fill={color}/>
        <circle cx={cx+s*0.54} cy={sY-s*0.04} r={s*0.02} fill="white" opacity="0.4"/>
        <circle cx={cx+s*0.525} cy={sY-s*0.055} r={s*0.016} fill="white" opacity="0.4"/>
      </g>
      {/* Front legs */}
      <rect x={cx-s*0.22} y={s*1.26} width={s*0.16} height={s*0.27} rx={s*0.08} fill={color}/>
      <rect x={cx+s*0.06} y={s*1.26} width={s*0.16} height={s*0.27} rx={s*0.08} fill={color}/>
      {/* Paws */}
      <ellipse cx={cx-s*0.14} cy={s*1.55} rx={s*0.1} ry={s*0.058} fill={color}/>
      <ellipse cx={cx+s*0.14} cy={s*1.55} rx={s*0.1} ry={s*0.058} fill={color}/>
      {[-s*0.2,-s*0.14,-s*0.08].map((dx,i)=>(<circle key={i} cx={cx+dx} cy={s*1.59} r={s*0.02} fill="white" opacity="0.4"/>))}
      {[s*0.08,s*0.14,s*0.2].map((dx,i)=>(<circle key={i} cx={cx+dx} cy={s*1.59} r={s*0.02} fill="white" opacity="0.4"/>))}
      {/* Tail */}
      <g style={{ animation:"dogTailWag 0.55s ease-in-out infinite", transformOrigin:`${tailBaseX}px ${tailBaseY}px` }}>
        <path d={`M${tailBaseX},${tailBaseY} Q${cx+s*0.52},${s*1.08} ${cx+s*0.46},${s*0.82}`}
          stroke={color} strokeWidth={s*0.1} fill="none" strokeLinecap="round"/>
        <ellipse cx={cx+s*0.47} cy={s*0.78} rx={s*0.068} ry={s*0.048} fill={color}/>
      </g>
      {/* ── HEAD ── */}
      {happy&&<circle cx={cx} cy={cy} r={s*.42} fill={color} opacity=".15"/>}
      <ellipse cx={cx-s*.34} cy={cy+s*.08} rx={s*.14} ry={s*.28} fill={color} opacity=".85" transform={`rotate(-12,${cx-s*.34},${cy+s*.08})`}/>
      <ellipse cx={cx+s*.34} cy={cy+s*.08} rx={s*.14} ry={s*.28} fill={color} opacity=".85" transform={`rotate(12,${cx+s*.34},${cy+s*.08})`}/>
      <ellipse cx={cx} cy={cy-s*.02} rx={s*.34} ry={s*.31} fill={color}/>
      <ellipse cx={cx} cy={cy+s*.14} rx={s*.18} ry={s*.13} fill="white" opacity=".6"/>
      <ellipse cx={cx} cy={cy+s*.08} rx={s*.07} ry={s*.05} fill="#333"/>
      <circle cx={cx-s*.025} cy={cy+s*.065} r={s*.018} fill="white" opacity=".7"/>
      {sad?[cx-s*.15,cx+s*.15].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.08} x2={ex+s*.06} y2={cy-s*.01} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.08} x2={ex-s*.06} y2={cy-s*.01} stroke="#444" strokeWidth="2.5" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.2} ${cy-s*.06} Q${cx-s*.13} ${cy-s*.14} ${cx-s*.06} ${cy-s*.06}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy-s*.06} Q${cx+s*.13} ${cy-s*.14} ${cx+s*.2} ${cy-s*.06}`} stroke="#333" strokeWidth="2.5" fill="none" strokeLinecap="round"/></>
      :<><ellipse cx={cx-s*.15} cy={cy-s*.07} rx={s*.065} ry={s*.07} fill="#333"/><ellipse cx={cx+s*.15} cy={cy-s*.07} rx={s*.065} ry={s*.07} fill="#333"/><circle cx={cx-s*.12} cy={cy-s*.1} r={s*.022} fill="white"/><circle cx={cx+s*.18} cy={cy-s*.1} r={s*.022} fill="white"/></>}
      {sad?<path d={`M${cx-s*.1} ${cy+s*.24} Q${cx} ${cy+s*.2} ${cx+s*.1} ${cy+s*.24}`} stroke="#888" strokeWidth="2" fill="none" strokeLinecap="round"/>:happy?<><path d={`M${cx-s*.1} ${cy+s*.18} Q${cx} ${cy+s*.27} ${cx+s*.1} ${cy+s*.18}`} stroke="#E07070" strokeWidth="2.5" fill="none" strokeLinecap="round"/><ellipse cx={cx} cy={cy+s*.22} rx={s*.07} ry={s*.04} fill="#FF9090" opacity=".5"/></>:<path d={`M${cx-s*.08} ${cy+s*.2} Q${cx} ${cy+s*.24} ${cx+s*.08} ${cy+s*.2}`} stroke="#888" strokeWidth="1.8" fill="none" strokeLinecap="round"/>}
      {(happy||okay)&&<><ellipse cx={cx-s*.3} cy={cy+s*.04} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.2}/><ellipse cx={cx+s*.3} cy={cy+s*.04} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.5:.2}/></>}
      {happy&&<text x={cx-s*.08} y={cy-s*.42} fontSize={s*.22}>🍖</text>}
      {sad&&<text x={cx-s*.05} y={cy+s*.54} fontSize={s*.16}>😋</text>}
    </svg>
  );
}

function UnicornBody({ pct, color, size=118 }) {
  const happy=pct>=0.8, okay=pct>=0.4, sad=pct<0.25;
  const s=size, cx=s/2, cy=s/2, H=s*BODY_RATIO;
  const tailBaseX=cx-s*0.26, tailBaseY=s*1.2;
  const rainbowCols=["#FF6B6B","#FFD700","#7BC97B","#5DADE2","#9B59B6"];
  const rSx=cx+s*0.22, lSx=cx-s*0.22, sY=s*0.9;
  const rAnim = sad ? undefined : happy ? "waveArmRight 2.6s ease-in-out infinite" : "idleArmRight 4.2s ease-in-out infinite";
  const lAnim = sad ? undefined : happy ? "waveArmLeft 3.0s ease-in-out infinite 0.7s" : "idleArmLeft 4.8s ease-in-out infinite 1.2s";
  return (
    <svg width={s} height={H} viewBox={`0 0 ${s} ${H}`} style={{overflow:"visible", display:"block"}}>
      {/* ── BODY ── */}
      <rect x={cx-s*0.09} y={cy+s*0.3} width={s*0.18} height={s*0.2} rx={s*0.065} fill={color}/>
      <ellipse cx={cx} cy={s*1.03} rx={s*0.26} ry={s*0.3} fill={color}/>
      <ellipse cx={cx} cy={s*1.06} rx={s*0.13} ry={s*0.17} fill="white" opacity="0.3"/>
      {/* Shoulder joints — slightly smaller for elegance */}
      <circle cx={lSx} cy={sY} r={s*0.058} fill={color}/>
      <circle cx={rSx} cy={sY} r={s*0.058} fill={color}/>
      {/* Left arm */}
      <g style={sad ? { transform:`rotate(-55deg)`, transformOrigin:`${lSx}px ${sY}px` } : { animation:lAnim, transformOrigin:`${lSx}px ${sY}px` }}>
        <rect x={cx-s*0.44} y={sY-s*0.044} width={s*0.22} height={s*0.092} rx={s*0.046} fill={color}/>
        <ellipse cx={cx-s*0.465} cy={sY+s*0.002} rx={s*0.048} ry={s*0.042} fill="#7B4B2A"/>
      </g>
      {/* Right arm */}
      <g style={sad ? { transform:`rotate(55deg)`, transformOrigin:`${rSx}px ${sY}px` } : { animation:rAnim, transformOrigin:`${rSx}px ${sY}px` }}>
        <rect x={cx+s*0.22} y={sY-s*0.044} width={s*0.22} height={s*0.092} rx={s*0.046} fill={color}/>
        <ellipse cx={cx+s*0.465} cy={sY+s*0.002} rx={s*0.048} ry={s*0.042} fill="#7B4B2A"/>
      </g>
      {/* Front legs */}
      <rect x={cx-s*0.2} y={s*1.26} width={s*0.13} height={s*0.27} rx={s*0.065} fill={color}/>
      <rect x={cx+s*0.07} y={s*1.26} width={s*0.13} height={s*0.27} rx={s*0.065} fill={color}/>
      {/* Hooves */}
      <ellipse cx={cx-s*0.135} cy={s*1.56} rx={s*0.075} ry={s*0.044} fill="#7B4B2A"/>
      <ellipse cx={cx+s*0.135} cy={s*1.56} rx={s*0.075} ry={s*0.044} fill="#7B4B2A"/>
      {/* Rainbow tail */}
      <g style={{ animation:"unicornTailFlow 3s ease-in-out infinite", transformOrigin:`${tailBaseX}px ${tailBaseY}px` }}>
        {rainbowCols.map((col,i)=>{const dx=i*s*0.032;return(<path key={i} d={`M${tailBaseX-dx},${tailBaseY} Q${cx-s*0.6-dx},${s*1.02} ${cx-s*0.52-dx},${s*0.58} Q${cx-s*0.44-dx},${s*0.35} ${cx-s*0.5-dx},${s*0.24}`} stroke={col} strokeWidth={s*0.054} fill="none" strokeLinecap="round" opacity="0.88"/>);})}
      </g>
      {/* ── HEAD ── */}
      {happy&&<circle cx={cx} cy={cy+s*.05} r={s*.42} fill={color} opacity=".15"/>}
      <ellipse cx={cx+s*.34} cy={cy-s*.18} rx={s*.1} ry={s*.2} fill="#C084FC" transform={`rotate(20,${cx+s*.34},${cy-s*.18})`}/>
      <ellipse cx={cx+s*.28} cy={cy-s*.24} rx={s*.09} ry={s*.18} fill="#F472B6" transform={`rotate(10,${cx+s*.28},${cy-s*.24})`}/>
      <ellipse cx={cx+s*.22} cy={cy-s*.27} rx={s*.08} ry={s*.16} fill="#818CF8"/>
      {happy&&<ellipse cx={cx+s*.15} cy={cy-s*.29} rx={s*.07} ry={s*.14} fill="#34D399" transform={`rotate(-8,${cx+s*.15},${cy-s*.29})`}/>}
      <polygon points={`${cx},${cy-s*.52} ${cx-s*.06},${cy-s*.28} ${cx+s*.06},${cy-s*.28}`} fill="#FCD34D"/>
      <line x1={cx} y1={cy-s*.5} x2={cx-s*.02} y2={cy-s*.3} stroke="#F59E0B" strokeWidth="1.2" opacity=".55"/>
      <polygon points={`${cx-s*.3},${cy-s*.22} ${cx-s*.38},${cy-s*.46} ${cx-s*.16},${cy-s*.3}`} fill={color}/>
      <polygon points={`${cx-s*.29},${cy-s*.24} ${cx-s*.35},${cy-s*.42} ${cx-s*.19},${cy-s*.31}`} fill="white" opacity=".45"/>
      <ellipse cx={cx} cy={cy+s*.04} rx={s*.35} ry={s*.32} fill={color}/>
      <ellipse cx={cx} cy={cy+s*.18} rx={s*.19} ry={s*.13} fill="white" opacity=".5"/>
      <circle cx={cx-s*.07} cy={cy+s*.19} r={s*.03} fill="#FDA4AF" opacity=".8"/>
      <circle cx={cx+s*.07} cy={cy+s*.19} r={s*.03} fill="#FDA4AF" opacity=".8"/>
      {sad?[cx-s*.14,cx+s*.14].map((ex,i)=>(<g key={i}><line x1={ex-s*.06} y1={cy-s*.04} x2={ex+s*.06} y2={cy+s*.03} stroke="#444" strokeWidth="2.4" strokeLinecap="round"/><line x1={ex+s*.06} y1={cy-s*.04} x2={ex-s*.06} y2={cy+s*.03} stroke="#444" strokeWidth="2.4" strokeLinecap="round"/></g>))
      :happy?<><path d={`M${cx-s*.22} ${cy} Q${cx-s*.14} ${cy-s*.1} ${cx-s*.06} ${cy}`} stroke="#333" strokeWidth="2.4" fill="none" strokeLinecap="round"/><path d={`M${cx+s*.06} ${cy} Q${cx+s*.14} ${cy-s*.1} ${cx+s*.22} ${cy}`} stroke="#333" strokeWidth="2.4" fill="none" strokeLinecap="round"/></>
      :<><ellipse cx={cx-s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><ellipse cx={cx+s*.14} cy={cy-s*.01} rx={s*.07} ry={s*.075} fill="#333"/><circle cx={cx-s*.11} cy={cy-s*.04} r={s*.025} fill="white"/><circle cx={cx+s*.17} cy={cy-s*.04} r={s*.025} fill="white"/></>}
      {sad?<path d={`M${cx-s*.1} ${cy+s*.27} Q${cx} ${cy+s*.22} ${cx+s*.1} ${cy+s*.27}`} stroke="#888" strokeWidth="1.8" fill="none" strokeLinecap="round"/>:<path d={`M${cx-s*.1} ${cy+s*.22} Q${cx} ${cy+s*.3} ${cx+s*.1} ${cy+s*.22}`} stroke="#888" strokeWidth={happy?"2.2":"1.8"} fill="none" strokeLinecap="round"/>}
      {(happy||okay)&&<><ellipse cx={cx-s*.28} cy={cy+s*.1} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.55:.25}/><ellipse cx={cx+s*.28} cy={cy+s*.1} rx={s*.07} ry={s*.04} fill="#FFB3C1" opacity={happy?.55:.25}/></>}
      {happy&&<><text x={cx-s*.52} y={cy-s*.28} fontSize={s*.18}>✨</text><text x={cx+s*.34} y={cy-s*.3} fontSize={s*.15}>🍰</text></>}
      {sad&&<text x={cx-s*.05} y={cy+s*.56} fontSize={s*.16}>😋</text>}
      {happy&&<><circle cx={cx-s*0.12} cy={cy-s*0.58} r={s*0.025} fill="#FFD700" style={{animation:"twinkle 1.6s ease-in-out infinite"}}/><circle cx={cx+s*0.14} cy={cy-s*0.62} r={s*0.02} fill="#F472B6" style={{animation:"twinkle 1.6s ease-in-out 0.4s infinite"}}/></>}
    </svg>
  );
}

// AnimalBody: full-body dispatch. Used by LiveAnimal and reaction overlays.
// AnimalFace stays for small-context renders (≤90px).
function AnimalBody({ animal, pct, color, size=118, outfit }) {
  const body = (() => {
    switch(animal) {
      case "dog":     return <DogBody     pct={pct} color={color} size={size}/>;
      case "unicorn": return <UnicornBody pct={pct} color={color} size={size}/>;
      default:        return <CatBody     pct={pct} color={color} size={size}/>;
    }
  })();

  const H = size * BODY_RATIO;

  if (!outfit || outfit === "none") return body;

  return (
    <div style={{ position:"relative", display:"inline-block", width:size, height:H, lineHeight:0 }}>
      {body}
      {/* Outfit overlay positioned at head coords — same cy=size/2 as face */}
      <svg width={size} height={H} viewBox={`0 0 ${size} ${H}`}
        style={{ position:"absolute", top:0, left:0, pointerEvents:"none", overflow:"visible" }}>
        <OutfitGraphic id={outfit} cx={size/2} cy={size/2} s={size}/>
      </svg>
    </div>
  );
}

// ── Outfits ───────────────────────────────────────────────────────────────────
// Cosmetic items unlocked at level milestones, interleaved with island tier
// unlocks (island at 2/4/6/9/12/15/18/22/26/30; outfits at 3/5/7/10/13/16/20/24/28/32).
// Stored as `outfitId` on the user profile. Rendered as an SVG overlay on top
// of any AnimalFace. All outfit graphics use the same coordinate system as the
// face (cx, cy = head centre, s = total size in viewBox units).

const OUTFITS = [
  { id:"none",      level:0,  label:"None",            hint:"No outfit." },
  { id:"party",     level:3,  label:"Party hat",       hint:"Pop the pompom!" },
  { id:"chef",      level:5,  label:"Chef hat",        hint:"Time to cook!" },
  { id:"shades",    level:7,  label:"Sunglasses",      hint:"Looking cool 😎" },
  { id:"bow",       level:10, label:"Bow tie",         hint:"Fancy occasion." },
  { id:"mask",      level:13, label:"Hero mask",       hint:"To the rescue!" },
  { id:"wizard",    level:16, label:"Wizard hat",      hint:"Magic powers." },
  { id:"crown",     level:20, label:"Crown",           hint:"Royal vibes." },
  { id:"flower",    level:24, label:"Flower",          hint:"Petal power." },
  { id:"goggles",   level:28, label:"Pilot goggles",   hint:"Up, up and away!" },
  { id:"halo",      level:32, label:"Rainbow halo",    hint:"Pure legend." },
];

const outfitById       = id    => OUTFITS.find(o => o.id === id) || OUTFITS[0];
const outfitsUnlocked  = level => OUTFITS.filter(o => level >= o.level);
const nextOutfitUnlock = level => OUTFITS.find(o => level < o.level) || null;

function OutfitGraphic({ id, cx, cy, s }) {
  switch(id) {
    case "party":   return <PartyHat       cx={cx} cy={cy} s={s}/>;
    case "chef":    return <ChefHat        cx={cx} cy={cy} s={s}/>;
    case "shades":  return <Sunglasses     cx={cx} cy={cy} s={s}/>;
    case "bow":     return <BowTie         cx={cx} cy={cy} s={s}/>;
    case "mask":    return <SuperheroMask  cx={cx} cy={cy} s={s}/>;
    case "wizard":  return <WizardHat      cx={cx} cy={cy} s={s}/>;
    case "crown":   return <Crown          cx={cx} cy={cy} s={s}/>;
    case "flower":  return <Flower         cx={cx} cy={cy} s={s}/>;
    case "goggles": return <PilotGoggles   cx={cx} cy={cy} s={s}/>;
    case "halo":    return <RainbowHalo    cx={cx} cy={cy} s={s}/>;
    default:        return null;
  }
}

function PartyHat({ cx, cy, s }) {
  // Cone tilted slightly for jaunty look, pompom on top.
  const baseY = cy - s*0.5, apexX = cx + s*0.05, apexY = cy - s*0.86;
  return (
    <g transform={`rotate(-8, ${cx}, ${baseY})`}>
      <ellipse cx={cx} cy={baseY} rx={s*0.18} ry={s*0.04} fill="#D63384"/>
      <polygon points={`${cx-s*0.18},${baseY} ${cx+s*0.18},${baseY} ${apexX},${apexY}`} fill="#FF6B9D"/>
      {/* Stripes */}
      <line x1={cx-s*0.13} y1={cy-s*0.55} x2={cx+s*0.135} y2={cy-s*0.555} stroke="#FFD700" strokeWidth={s*0.018} strokeLinecap="round"/>
      <line x1={cx-s*0.08} y1={cy-s*0.66} x2={cx+s*0.105} y2={cy-s*0.665} stroke="#5DADE2" strokeWidth={s*0.018} strokeLinecap="round"/>
      <line x1={cx-s*0.04} y1={cy-s*0.76} x2={cx+s*0.075} y2={cy-s*0.765} stroke="#7BC97B" strokeWidth={s*0.016} strokeLinecap="round"/>
      {/* Pompom */}
      <circle cx={apexX} cy={apexY} r={s*0.07} fill="#FFD700"/>
      <circle cx={apexX-s*0.02} cy={apexY-s*0.02} r={s*0.025} fill="#FFFFFF" opacity="0.7"/>
    </g>
  );
}

function ChefHat({ cx, cy, s }) {
  // White pillow shape with a band at the base.
  return (
    <g>
      <rect x={cx-s*0.2} y={cy-s*0.55} width={s*0.4} height={s*0.08} fill="#FFFFFF" stroke="#CCCCCC" strokeWidth={s*0.008}/>
      <ellipse cx={cx-s*0.13} cy={cy-s*0.65} rx={s*0.13} ry={s*0.16} fill="#FFFFFF" stroke="#CCCCCC" strokeWidth={s*0.008}/>
      <ellipse cx={cx+s*0.13} cy={cy-s*0.65} rx={s*0.13} ry={s*0.16} fill="#FFFFFF" stroke="#CCCCCC" strokeWidth={s*0.008}/>
      <ellipse cx={cx} cy={cy-s*0.71} rx={s*0.14} ry={s*0.18} fill="#FFFFFF" stroke="#CCCCCC" strokeWidth={s*0.008}/>
      {/* Subtle shading */}
      <ellipse cx={cx-s*0.08} cy={cy-s*0.74} rx={s*0.05} ry={s*0.08} fill="#FFFFFF"/>
    </g>
  );
}

function Sunglasses({ cx, cy, s }) {
  // Two black lenses with a bridge across, sits over eye area.
  return (
    <g>
      <ellipse cx={cx-s*0.16} cy={cy-s*0.02} rx={s*0.12} ry={s*0.09} fill="#1A1A1A" stroke="#000000" strokeWidth={s*0.01}/>
      <ellipse cx={cx+s*0.16} cy={cy-s*0.02} rx={s*0.12} ry={s*0.09} fill="#1A1A1A" stroke="#000000" strokeWidth={s*0.01}/>
      <line x1={cx-s*0.05} y1={cy-s*0.04} x2={cx+s*0.05} y2={cy-s*0.04} stroke="#000000" strokeWidth={s*0.025} strokeLinecap="round"/>
      {/* Lens highlights */}
      <ellipse cx={cx-s*0.19} cy={cy-s*0.06} rx={s*0.03} ry={s*0.022} fill="#FFFFFF" opacity="0.55"/>
      <ellipse cx={cx+s*0.13} cy={cy-s*0.06} rx={s*0.03} ry={s*0.022} fill="#FFFFFF" opacity="0.55"/>
    </g>
  );
}

function BowTie({ cx, cy, s }) {
  // Below the chin.
  const bowY = cy + s*0.45;
  return (
    <g>
      <polygon points={`${cx-s*0.22},${bowY-s*0.07} ${cx-s*0.04},${bowY} ${cx-s*0.22},${bowY+s*0.07}`} fill="#E63946"/>
      <polygon points={`${cx+s*0.22},${bowY-s*0.07} ${cx+s*0.04},${bowY} ${cx+s*0.22},${bowY+s*0.07}`} fill="#E63946"/>
      {/* Highlights */}
      <polygon points={`${cx-s*0.2},${bowY-s*0.05} ${cx-s*0.07},${bowY-s*0.005} ${cx-s*0.2},${bowY+s*0.005}`} fill="#FF6B6B" opacity="0.7"/>
      <polygon points={`${cx+s*0.2},${bowY-s*0.05} ${cx+s*0.07},${bowY-s*0.005} ${cx+s*0.2},${bowY+s*0.005}`} fill="#FF6B6B" opacity="0.7"/>
      {/* Knot */}
      <rect x={cx-s*0.04} y={bowY-s*0.06} width={s*0.08} height={s*0.12} rx={s*0.015} fill="#B81F2E"/>
    </g>
  );
}

function SuperheroMask({ cx, cy, s }) {
  // Bandit/superhero eye-band with curved cutouts.
  const my = cy - s*0.02;
  return (
    <g>
      <path
        d={`M${cx-s*0.32},${my-s*0.05}
            Q${cx-s*0.36},${my+s*0.06} ${cx-s*0.22},${my+s*0.085}
            Q${cx-s*0.14},${my+s*0.05} ${cx-s*0.06},${my+s*0.085}
            L${cx-s*0.06},${my-s*0.07}
            Q${cx-s*0.14},${my-s*0.11} ${cx-s*0.22},${my-s*0.075}
            Z`}
        fill="#7B2CBF"/>
      <path
        d={`M${cx+s*0.32},${my-s*0.05}
            Q${cx+s*0.36},${my+s*0.06} ${cx+s*0.22},${my+s*0.085}
            Q${cx+s*0.14},${my+s*0.05} ${cx+s*0.06},${my+s*0.085}
            L${cx+s*0.06},${my-s*0.07}
            Q${cx+s*0.14},${my-s*0.11} ${cx+s*0.22},${my-s*0.075}
            Z`}
        fill="#7B2CBF"/>
      {/* Sheen */}
      <path d={`M${cx-s*0.28},${my-s*0.03} Q${cx-s*0.18},${my-s*0.06} ${cx-s*0.1},${my-s*0.04}`} stroke="#9D4EDD" strokeWidth={s*0.012} fill="none" opacity="0.7"/>
    </g>
  );
}

function WizardHat({ cx, cy, s }) {
  // Tall pointy cone with a wavy brim, sprinkled with stars.
  return (
    <g>
      {/* Brim */}
      <path d={`M${cx-s*0.26},${cy-s*0.5}
                Q${cx-s*0.2},${cy-s*0.46} ${cx-s*0.1},${cy-s*0.5}
                Q${cx},${cy-s*0.54} ${cx+s*0.1},${cy-s*0.5}
                Q${cx+s*0.2},${cy-s*0.46} ${cx+s*0.26},${cy-s*0.5}
                L${cx+s*0.26},${cy-s*0.55}
                L${cx-s*0.26},${cy-s*0.55} Z`}
        fill="#3A0CA3"/>
      {/* Cone body */}
      <path d={`M${cx-s*0.18},${cy-s*0.55}
                Q${cx-s*0.04},${cy-s*0.75} ${cx+s*0.02},${cy-s*0.95}
                Q${cx+s*0.08},${cy-s*0.7} ${cx+s*0.18},${cy-s*0.55} Z`}
        fill="#5A189A"/>
      {/* Stars */}
      <text x={cx-s*0.08} y={cy-s*0.62} fontSize={s*0.1} fill="#FFD700">★</text>
      <text x={cx+s*0.02} y={cy-s*0.78} fontSize={s*0.075} fill="#FFD700">★</text>
      <text x={cx-s*0.02} y={cy-s*0.7} fontSize={s*0.06} fill="#FFFFFF">✦</text>
    </g>
  );
}

function Crown({ cx, cy, s }) {
  // Five jeweled points on a gold band.
  const baseY = cy - s*0.5;
  return (
    <g>
      <rect x={cx-s*0.22} y={baseY-s*0.05} width={s*0.44} height={s*0.1} fill="#FFC300" stroke="#B8860B" strokeWidth={s*0.008}/>
      {/* Points */}
      {[-0.18, -0.09, 0, 0.09, 0.18].map((dx, i) => (
        <polygon key={i}
          points={`${cx+s*dx-s*0.04},${baseY-s*0.05} ${cx+s*dx+s*0.04},${baseY-s*0.05} ${cx+s*dx},${baseY-s*0.18}`}
          fill="#FFD700" stroke="#B8860B" strokeWidth={s*0.008}/>
      ))}
      {/* Jewels on points */}
      <circle cx={cx-s*0.18} cy={baseY-s*0.16} r={s*0.022} fill="#E63946"/>
      <circle cx={cx-s*0.09} cy={baseY-s*0.16} r={s*0.022} fill="#5DADE2"/>
      <circle cx={cx}        cy={baseY-s*0.16} r={s*0.025} fill="#9B59B6"/>
      <circle cx={cx+s*0.09} cy={baseY-s*0.16} r={s*0.022} fill="#5DADE2"/>
      <circle cx={cx+s*0.18} cy={baseY-s*0.16} r={s*0.022} fill="#E63946"/>
      {/* Band shading */}
      <rect x={cx-s*0.22} y={baseY-s*0.02} width={s*0.44} height={s*0.025} fill="#FFE066" opacity="0.6"/>
    </g>
  );
}

function Flower({ cx, cy, s }) {
  // Big flower on the side of the head (right ear area).
  const fx = cx + s*0.32, fy = cy - s*0.36;
  return (
    <g transform={`rotate(15, ${fx}, ${fy})`}>
      {[0, 72, 144, 216, 288].map(angle => (
        <ellipse key={angle} cx={fx} cy={fy-s*0.07} rx={s*0.06} ry={s*0.09} fill="#FF6B9D"
          transform={`rotate(${angle}, ${fx}, ${fy})`}/>
      ))}
      <circle cx={fx} cy={fy} r={s*0.05} fill="#FFD700"/>
      <circle cx={fx-s*0.015} cy={fy-s*0.015} r={s*0.018} fill="#FFE066"/>
    </g>
  );
}

function PilotGoggles({ cx, cy, s }) {
  // Round leather goggles with a strap that wraps around.
  const my = cy - s*0.02;
  return (
    <g>
      {/* Strap (across forehead) */}
      <path d={`M${cx-s*0.4},${my-s*0.04} Q${cx},${my-s*0.13} ${cx+s*0.4},${my-s*0.04}`}
        stroke="#6B4226" strokeWidth={s*0.04} fill="none" strokeLinecap="round"/>
      {/* Lenses */}
      <circle cx={cx-s*0.16} cy={my} r={s*0.11} fill="#8B4513" stroke="#3E2723" strokeWidth={s*0.018}/>
      <circle cx={cx-s*0.16} cy={my} r={s*0.085} fill="#5DC8E5"/>
      <circle cx={cx+s*0.16} cy={my} r={s*0.11} fill="#8B4513" stroke="#3E2723" strokeWidth={s*0.018}/>
      <circle cx={cx+s*0.16} cy={my} r={s*0.085} fill="#5DC8E5"/>
      {/* Bridge */}
      <rect x={cx-s*0.05} y={my-s*0.02} width={s*0.1} height={s*0.04} fill="#6B4226" rx={s*0.01}/>
      {/* Lens highlights */}
      <ellipse cx={cx-s*0.19} cy={my-s*0.04} rx={s*0.025} ry={s*0.018} fill="#FFFFFF" opacity="0.7"/>
      <ellipse cx={cx+s*0.13} cy={my-s*0.04} rx={s*0.025} ry={s*0.018} fill="#FFFFFF" opacity="0.7"/>
    </g>
  );
}

function RainbowHalo({ cx, cy, s }) {
  // Floating rainbow ring above the head.
  const ry = cy - s*0.55;
  return (
    <g style={{ animation:"haloFloat 2.4s ease-in-out infinite" }}>
      <ellipse cx={cx} cy={ry} rx={s*0.28} ry={s*0.07} fill="none" stroke="#FF4757" strokeWidth={s*0.016}/>
      <ellipse cx={cx} cy={ry} rx={s*0.255} ry={s*0.058} fill="none" stroke="#FFA500" strokeWidth={s*0.016}/>
      <ellipse cx={cx} cy={ry} rx={s*0.23} ry={s*0.046} fill="none" stroke="#FFD700" strokeWidth={s*0.016}/>
      <ellipse cx={cx} cy={ry} rx={s*0.205} ry={s*0.034} fill="none" stroke="#7BC97B" strokeWidth={s*0.016}/>
      <ellipse cx={cx} cy={ry} rx={s*0.18} ry={s*0.022} fill="none" stroke="#5DADE2" strokeWidth={s*0.016}/>
      {/* Sparkles */}
      <text x={cx-s*0.32} y={ry-s*0.02} fontSize={s*0.08} fill="#FFFFFF">✨</text>
      <text x={cx+s*0.24} y={ry-s*0.04} fontSize={s*0.07} fill="#FFFFFF">✨</text>
    </g>
  );
}

// ── localStorage layer ────────────────────────────────────────────────────────
const LS = {
  profiles: "tdf_profiles",
  library:  "tdf_library",   // { userId: [{...food}] }
  plans:    "tdf_plans",     // { "userId-date-slot": foodId }
  logs:     "tdf_logs",      // { "userId-date-slot": {...log} }
  xp:       "tdf_xp",        // { "userId-date": {...xp} }
  lastSync: "tdf_lastSync",  // ISO timestamp of last successful bulk fetch
};

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── Plan format migration ─────────────────────────────────────────────────────
// Phase 1 stored plans as bare foodId strings: { "userId-date-slot": "foodId" }.
// Phase 2 stores them as objects: { "userId-date-slot": { foodId, updatedAt } }
// so the tombstone-aware merge logic (used for logs/library/xp) can apply.
// This migration is idempotent — safe to run on already-migrated data, and
// safe to run on data from a device that had partial old/new mixed entries.
function migratePlans(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  Object.entries(raw).forEach(([k, v]) => {
    if (!v) return;
    if (typeof v === "string") {
      // Old format: bare foodId string. Treat as legacy entry with no
      // updatedAt — cloud will overwrite it on next sync if it knows better.
      if (v.length > 0) out[k] = { foodId: v, updatedAt: "" };
    } else if (typeof v === "object" && v.foodId) {
      out[k] = { foodId: String(v.foodId), updatedAt: v.updatedAt || "" };
    }
  });
  return out;
}

// ── Sync merge helper ─────────────────────────────────────────────────────────
// Decides whether a local record (whose key is not present in the latest cloud
// response) should be kept or dropped.
// - If we've never synced before (lastSync is null), keep everything local.
//   We can't tell if it was deleted elsewhere or just never uploaded yet.
// - If the local record's updatedAt is OLDER than our last successful sync,
//   the cloud knew about it once and now doesn't → it was deleted elsewhere → drop.
// - If the local record's updatedAt is NEWER than last sync, it's a local change
//   that hasn't been uploaded yet (or just was, mid-fetch) → keep.
// Records lacking an updatedAt are treated as "old" and droppable, since we
// can't prove they're recent.
function shouldKeepLocal(localRecord, lastSyncIso) {
  if (!lastSyncIso) return true;
  const ua = localRecord?.updatedAt;
  if (!ua) return false;
  return ua > lastSyncIso;
}

// ── XP tally helpers ──────────────────────────────────────────────────────────
function recomputeDayXp(userId, dateStr, allLogs) {
  let dailyXp = 0, mealsCompleted = 0, allRated = 0, newFoodsTried = 0;
  ["breakfast","lunch","dinner"].forEach(slot => {
    const log = allLogs[`${userId}-${dateStr}-${slot}`];
    if (log) {
      mealsCompleted++;
      dailyXp += log.xpEarned || 0;
      if (log.rating === "all") allRated++;
      if (log.wasNew) newFoodsTried++;
    }
  });
  // Snacks (slot starts with "snack")
  Object.entries(allLogs).forEach(([k, log]) => {
    if (k.startsWith(`${userId}-${dateStr}-snack`)) {
      dailyXp += log.xpEarned || 0;
      if (log.wasNew) newFoodsTried++;
    }
  });
  const perfectDay = mealsCompleted === 3 && allRated === 3;
  if (perfectDay) dailyXp += XP_PERFECT_DAY;
  return { dailyXp, mealsCompleted, perfectDay, newFoodsTried };
}

function recomputeUserTotalXp(userId, allXp) {
  let total = 0;
  Object.entries(allXp).forEach(([k, v]) => {
    if (k.startsWith(`${userId}-`)) total += v.dailyXp || 0;
  });
  return total;
}

// ── UI primitives ─────────────────────────────────────────────────────────────
function SectionCard({ title, hint, children, action }) {
  return (
    <div style={{ background:"white", borderRadius:24, padding:"18px 18px", marginBottom:14, boxShadow:"0 4px 20px rgba(0,0,0,0.05)" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:hint?4:12 }}>
        <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb" }}>{title}</div>
        {action}
      </div>
      {hint&&<div style={{ fontSize:11, color:"#ccc", fontWeight:600, marginBottom:12 }}>{hint}</div>}
      {children}
    </div>
  );
}

function GhostButton({ onClick, children, style }) {
  return (
    <button onClick={onClick} style={{ background:"rgba(255,255,255,0.18)", border:"none", borderRadius:14, padding:"8px 16px", color:"white", fontSize:13, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", ...style }}>
      {children}
    </button>
  );
}

function PrimaryButton({ onClick, color, children, disabled, style }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background:disabled?"#ddd":color, border:"none", borderRadius:18, padding:"14px 18px", color:"white", fontSize:15, fontWeight:900, cursor:disabled?"default":"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:disabled?"none":`0 4px 14px ${color}55`, ...style }}>
      {children}
    </button>
  );
}

// ── Photo thumb / hero ────────────────────────────────────────────────────────
function PhotoThumb({ photoId, size=44, fallback="🍽️", radius=10 }) {
  if (!photoId) return (
    <div style={{ width:size, height:size, borderRadius:radius, background:"#f3f3f3", display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.5 }}>{fallback}</div>
  );
  return (
    <div style={{ width:size, height:size, borderRadius:radius, overflow:"hidden", background:"#f3f3f3", flexShrink:0 }}>
      <img src={photoUrl(photoId)} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} loading="lazy"/>
    </div>
  );
}

// ── XP bar ────────────────────────────────────────────────────────────────────
function XpBar({ totalXp, color, light }) {
  const { lvl, current, needed, pct } = xpProgressInLevel(totalXp);
  return (
    <div style={{ background:light, borderRadius:18, padding:"10px 14px" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ background:color, color:"white", borderRadius:10, padding:"3px 10px", fontWeight:900, fontSize:13, boxShadow:`0 2px 8px ${color}55` }}>LV {lvl}</div>
          <div style={{ fontSize:12, fontWeight:800, color:color }}>{current} / {needed} XP</div>
        </div>
        <div style={{ fontSize:11, fontWeight:700, color:"#999" }}>{totalXp} total</div>
      </div>
      <div style={{ height:8, background:"rgba(0,0,0,0.06)", borderRadius:4, overflow:"hidden" }}>
        <div style={{ height:8, width:`${pct*100}%`, background:color, borderRadius:4, transition:"width 0.5s ease" }}/>
      </div>
    </div>
  );
}

// ── Slot card on Today screen ─────────────────────────────────────────────────
function SlotCard({ slot, log, plan, food, color, dark, light, onTap }) {
  const isLogged = !!log;
  const isPlanned = !isLogged && !!plan;
  const ratingMeta = log ? RATINGS.find(r => r.id === log.rating) : null;

  return (
    <div onClick={onTap}
      style={{ background:isLogged?"white":isPlanned?"rgba(255,255,255,0.65)":light, borderRadius:22, padding:"14px 16px", marginBottom:10, cursor:"pointer", display:"flex", alignItems:"center", gap:14, boxShadow:isLogged?"0 4px 18px rgba(0,0,0,0.08)":"0 2px 8px rgba(0,0,0,0.04)", border:isPlanned?`2px dashed ${color}55`:"2px solid transparent", transition:"transform 0.1s" }}
      onMouseDown={e=>e.currentTarget.style.transform="scale(0.98)"}
      onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
      onTouchStart={e=>e.currentTarget.style.transform="scale(0.98)"}
      onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>

      <div style={{ width:56, height:56, borderRadius:16, background:isLogged?light:"rgba(255,255,255,0.5)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:28, position:"relative" }}>
        {food && food.heroPhotoId ? (
          <PhotoThumb photoId={log?.photoId || food.heroPhotoId} size={56} radius={16}/>
        ) : food ? food.emoji : slot.emoji}
        {log?.wasNew && (
          <div style={{ position:"absolute", top:-6, right:-6, background:"#FFD700", borderRadius:10, padding:"2px 6px", fontSize:9, fontWeight:900, color:"#7a5a00", border:"1.5px solid white" }}>NEW</div>
        )}
      </div>

      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:11, fontWeight:800, letterSpacing:1, color:"#bbb" }}>{slot.label.toUpperCase()}</div>
        <div style={{ fontSize:16, fontWeight:900, color:dark, marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
          {food ? food.name : isPlanned ? "Planned" : "Tap to log"}
        </div>
        {isLogged && ratingMeta && (
          <div style={{ fontSize:12, fontWeight:700, color:color, marginTop:2 }}>
            {ratingMeta.emoji} {ratingMeta.label} · +{log.xpEarned} XP
          </div>
        )}
        {isPlanned && !isLogged && (
          <div style={{ fontSize:12, fontWeight:700, color:color, marginTop:2 }}>Tap when eaten</div>
        )}
      </div>

      <div style={{ fontSize:20, color:isLogged?"#4CAF85":"#ccc" }}>{isLogged?"✓":"›"}</div>
    </div>
  );
}

// ── Snack row ─────────────────────────────────────────────────────────────────
function SnackRow({ log, food, color, light, onDelete }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:light, borderRadius:14, marginBottom:6 }}>
      <PhotoThumb photoId={log.photoId || food?.heroPhotoId} size={36} fallback={food?.emoji || "🍪"} radius={10}/>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:800, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{food?.name || "Snack"}</div>
        <div style={{ fontSize:11, fontWeight:700, color:color }}>+{log.xpEarned} XP {log.wasNew && "· ✨ NEW"}</div>
      </div>
      <button onClick={onDelete} style={{ background:"none", border:"none", color:"#ccc", fontSize:16, cursor:"pointer", padding:4 }}>✕</button>
    </div>
  );
}

// ── Food picker (used by log + plan flows) ────────────────────────────────────
// `featuredFood`: when provided (e.g. the kid is logging on a slot the parent
// planned), this food is pinned at the top with a "PLANNED" badge and removed
// from the main grid so it can't appear twice.
// `onAddNew`: when null, the "+ Add a brand new food" button is hidden — used
// by the parent planner where library management isn't part of the flow.
function FoodPicker({ user, library, slot, featuredFood, onPick, onAddNew, onClose, theme }) {
  const [filter, setFilter] = useState("all"); // all | tried | untried | category
  const userLib = library[user.id] || [];

  let shown = userLib;
  if (featuredFood) shown = shown.filter(f => f.foodId !== featuredFood.foodId);
  if (filter === "tried")    shown = shown.filter(f => f.tried);
  if (filter === "untried")  shown = shown.filter(f => !f.tried);
  if (filter === "matching" && slot) {
    shown = shown.filter(f => f.category === slot || f.category === "any");
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:80, display:"flex", flexDirection:"column", justifyContent:"flex-end" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 24px", maxHeight:"85vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
          <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>Pick a food</div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {onAddNew && (
              <button onClick={onAddNew}
                style={{ background:theme.accent, color:"white", border:"none", borderRadius:18, padding:"8px 14px", fontSize:13, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:`0 3px 10px ${theme.accent}55`, whiteSpace:"nowrap" }}>
                + New
              </button>
            )}
            <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999", flexShrink:0 }}>✕</button>
          </div>
        </div>

        <div style={{ display:"flex", gap:6, padding:"0 20px 12px", overflowX:"auto" }}>
          {[
            { id:"all",      label:"All" },
            { id:"matching", label:slot ? `For ${slot}` : "Any" },
            { id:"untried",  label:"Not tried yet" },
            { id:"tried",    label:"Favourites" },
          ].map(f => (
            <button key={f.id} onClick={()=>setFilter(f.id)}
              style={{ background:filter===f.id?theme.accent:"#f5f5f5", color:filter===f.id?"white":"#999", border:"none", borderRadius:14, padding:"8px 14px", fontSize:12, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", whiteSpace:"nowrap" }}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ overflowY:"auto", padding:"0 16px 8px", flex:1 }}>
          {featuredFood && (
            <button onClick={()=>onPick(featuredFood)}
              style={{ width:"100%", background:`linear-gradient(135deg, ${theme.accent}, ${theme.dark})`, border:"none", borderRadius:18, padding:"12px 14px", marginBottom:12, cursor:"pointer", display:"flex", alignItems:"center", gap:12, fontFamily:"'Nunito',sans-serif", color:"white", boxShadow:`0 4px 16px ${theme.accent}55` }}>
              <PhotoThumb photoId={featuredFood.heroPhotoId} size={48} fallback={featuredFood.emoji} radius={12}/>
              <div style={{ flex:1, minWidth:0, textAlign:"left" }}>
                <div style={{ fontSize:10, fontWeight:900, letterSpacing:1.5, opacity:0.9 }}>📋 PLANNED</div>
                <div style={{ fontSize:15, fontWeight:900, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{featuredFood.name}</div>
              </div>
              <div style={{ fontSize:18, opacity:0.85 }}>›</div>
            </button>
          )}

          {shown.length === 0 ? (
            <div style={{ textAlign:"center", padding:"40px 0", color:"#bbb", fontSize:13, fontWeight:700 }}>
              {userLib.length === 0 ? "Your library is empty. Add your first food above!" : "No foods in this filter."}
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {shown.sort((a,b)=>(b.timesEaten||0)-(a.timesEaten||0)).map(food => (
                <button key={food.foodId} onClick={()=>onPick(food)}
                  style={{ background:"white", border:"2px solid #f0f0f0", borderRadius:18, padding:"12px 10px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:6, fontFamily:"'Nunito',sans-serif", position:"relative" }}>
                  {!food.tried && (
                    <div style={{ position:"absolute", top:6, right:6, background:"#FFD700", borderRadius:8, padding:"2px 6px", fontSize:9, fontWeight:900, color:"#7a5a00" }}>NEW!</div>
                  )}
                  <PhotoThumb photoId={food.heroPhotoId} size={64} fallback={food.emoji} radius={14}/>
                  <div style={{ fontSize:13, fontWeight:800, color:"#333", textAlign:"center", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:"100%" }}>{food.name}</div>
                  {food.timesEaten > 0 && (
                    <div style={{ fontSize:10, fontWeight:700, color:"#bbb" }}>{food.timesEaten}× eaten</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Add new food modal ────────────────────────────────────────────────────────
function AddFoodModal({ user, theme, defaultCategory, onSave, onClose }) {
  const [name, setName]         = useState("");
  const [emoji, setEmoji]       = useState("🍽️");
  const [category, setCategory] = useState(defaultCategory || "any");
  const [photoId, setPhotoId]   = useState(null);
  const [photoPreview, setPreview] = useState(null);
  const [uploading, setUploading]  = useState(false);
  const [emojiOpen, setEmojiOpen]  = useState(false);
  const fileRef = useRef(null);

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { dataB64, mimeType } = await compressImage(file);
      setPreview("data:" + mimeType + ";base64," + dataB64);
      const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      const id = await uploadPhoto(user.id, "lib", tempId, dataB64, mimeType);
      setPhotoId(id);
    } catch(err) { alert("Photo upload failed. You can add it later from the library."); }
    finally { setUploading(false); }
  };

  const handleSave = () => {
    if (!name.trim()) return;
    const foodId = `f_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    onSave({
      foodId,
      name: name.trim(),
      emoji,
      category,
      heroPhotoId: photoId || "",
      tried: false,
      firstTried: "",
      timesEaten: 0,
    });
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:90, display:"flex", flexDirection:"column", justifyContent:"flex-end" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", maxHeight:"90vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>New food 🌟</div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
        </div>

        <div style={{ padding:"0 20px", overflowY:"auto", flex:1 }}>
          {/* Photo */}
          <div style={{ display:"flex", justifyContent:"center", marginBottom:16 }}>
            <button onClick={()=>fileRef.current?.click()}
              style={{ width:140, height:140, borderRadius:24, background:photoPreview?"transparent":theme.light, border:`2px dashed ${theme.accent}55`, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden", padding:0, position:"relative" }}>
              {uploading ? (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, color:theme.accent, fontWeight:800, fontSize:12 }}>
                  <div style={{ animation:"spin 1s linear infinite" }}>⟳</div> Saving…
                </div>
              ) : photoPreview ? (
                <img src={photoPreview} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4, color:theme.accent }}>
                  <div style={{ fontSize:34 }}>📷</div>
                  <div style={{ fontSize:12, fontWeight:800 }}>Add photo</div>
                </div>
              )}
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display:"none" }}/>
          </div>

          {/* Name */}
          <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", marginBottom:6 }}>NAME</div>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Pasta with tomato sauce"
            style={{ width:"100%", border:`2px solid ${theme.accent}33`, borderRadius:14, padding:"12px 14px", fontSize:16, fontWeight:700, color:"#333", fontFamily:"'Nunito',sans-serif", outline:"none", background:theme.light, boxSizing:"border-box", marginBottom:14 }}/>

          {/* Emoji */}
          <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", marginBottom:6 }}>EMOJI (used if no photo)</div>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
            <button onClick={()=>setEmojiOpen(o=>!o)}
              style={{ width:54, height:54, borderRadius:14, background:theme.light, border:`2px solid ${theme.accent}33`, fontSize:26, cursor:"pointer" }}>{emoji}</button>
            <div style={{ fontSize:12, color:"#bbb", fontWeight:600 }}>Tap to change</div>
          </div>
          {emojiOpen && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:6, padding:"10px", background:theme.light, borderRadius:14, marginBottom:14, maxHeight:160, overflowY:"auto" }}>
              {FOOD_EMOJIS.map(e => (
                <button key={e} onClick={()=>{setEmoji(e);setEmojiOpen(false);}}
                  style={{ background:emoji===e?"white":"transparent", border:emoji===e?`2px solid ${theme.accent}`:"2px solid transparent", borderRadius:8, padding:6, fontSize:20, cursor:"pointer" }}>{e}</button>
              ))}
            </div>
          )}

          {/* Category */}
          <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", marginBottom:6 }}>BEST FOR</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:18 }}>
            {CATEGORIES.map(c => (
              <button key={c.id} onClick={()=>setCategory(c.id)}
                style={{ background:category===c.id?theme.accent:"#f5f5f5", color:category===c.id?"white":"#999", border:"none", borderRadius:14, padding:"8px 14px", fontSize:12, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding:"0 20px" }}>
          <PrimaryButton onClick={handleSave} color={theme.accent} disabled={!name.trim() || uploading} style={{ width:"100%" }}>
            Save to library ✓
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ── Logged slot action popup (tap an already-logged main meal) ────────────────
function LoggedSlotActions({ slot, log, food, theme, onView, onRelog, onDelete, onClose }) {
  const ratingMeta = RATINGS.find(r => r.id === log.rating);
  const hasPhoto = !!(log.photoId || food?.heroPhotoId);
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:88, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", animation:"slideUp 0.25s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>

        <div style={{ padding:"8px 20px 16px", borderBottom:"1px solid #f0f0f0", display:"flex", alignItems:"center", gap:14 }}>
          <PhotoThumb photoId={log.photoId || food?.heroPhotoId} size={56} fallback={food?.emoji || "🍽️"} radius={16}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:11, fontWeight:800, letterSpacing:1, color:"#bbb" }}>
              {SLOTS.find(s=>s.id===slot)?.label.toUpperCase()}
            </div>
            <div style={{ fontSize:17, fontWeight:900, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
              {food?.name || "Unknown"}
            </div>
            {ratingMeta && (
              <div style={{ fontSize:12, fontWeight:700, color:theme.accent, marginTop:2 }}>
                {ratingMeta.emoji} {ratingMeta.label} · +{log.xpEarned} XP {log.wasNew && "✨"}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
        </div>

        <div style={{ padding:"16px 20px 0", display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={onRelog}
            style={{ width:"100%", background:theme.accent, color:"white", border:"none", borderRadius:16, padding:"14px", fontSize:15, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:`0 4px 14px ${theme.accent}55`, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            ✏️ Edit this meal
          </button>

          {hasPhoto && (
            <button onClick={onView}
              style={{ width:"100%", background:theme.light, color:theme.accent, border:`2px solid ${theme.accent}33`, borderRadius:16, padding:"12px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              👁️ View photo
            </button>
          )}

          <button onClick={onDelete}
            style={{ width:"100%", background:"white", color:"#E05555", border:"2px solid #FFE0E0", borderRadius:16, padding:"12px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            🗑️ Delete this log
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Photo viewer (full-screen lightbox) ───────────────────────────────────────
function PhotoViewer({ photoId, onClose }) {
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:95, display:"flex", alignItems:"center", justifyContent:"center", padding:20, cursor:"pointer" }}>
      <img src={photoUrl(photoId)} alt="" style={{ maxWidth:"100%", maxHeight:"100%", borderRadius:16, boxShadow:"0 8px 40px rgba(0,0,0,0.6)" }}/>
      <button onClick={onClose} style={{ position:"absolute", top:20, right:20, background:"rgba(255,255,255,0.18)", border:"none", borderRadius:"50%", width:40, height:40, fontSize:18, cursor:"pointer", color:"white", backdropFilter:"blur(8px)" }}>✕</button>
    </div>
  );
}

// ── Log meal modal (after picking food) ───────────────────────────────────────
function LogMealModal({ user, theme, food, slot, existingLog, onSave, onClose }) {
  const [rating, setRating]   = useState(existingLog?.rating || null);
  // Default OFF. Only offer the NEW option for foods the kid hasn't tried yet
  // (or that were marked new on the existing log we're now editing).
  const canBeNew = !food.tried || !!existingLog?.wasNew;
  const [wasNew, setWasNew]   = useState(existingLog?.wasNew || false);
  const [photoId, setPhotoId] = useState(existingLog?.photoId || null);
  const [photoPreview, setPreview] = useState(null);
  const [uploading, setUploading]  = useState(false);
  const fileRef = useRef(null);

  const isSnack = slot === "snack";

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { dataB64, mimeType } = await compressImage(file);
      setPreview("data:" + mimeType + ";base64," + dataB64);
      const tempId = `${today()}_${slot}_${Date.now()}`;
      const id = await uploadPhoto(user.id, "log", tempId, dataB64, mimeType);
      setPhotoId(id);
    } catch(err) { alert("Photo upload failed."); }
    finally { setUploading(false); }
  };

  const xpPreview = calcLogXp({
    rating: rating || (isSnack ? "all" : "all"),
    wasNew, hasPhoto: !!photoId, slot,
  });

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:85, display:"flex", flexDirection:"column", justifyContent:"flex-end" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", maxHeight:"90vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>

        <div style={{ padding:"8px 20px 16px", borderBottom:"1px solid #f0f0f0" }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <PhotoThumb photoId={food.heroPhotoId} size={56} fallback={food.emoji} radius={16}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:11, fontWeight:800, letterSpacing:1, color:"#bbb" }}>{isSnack ? "SNACK" : SLOTS.find(s=>s.id===slot)?.label.toUpperCase()}</div>
              <div style={{ fontSize:18, fontWeight:900, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{food.name}</div>
            </div>
            <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
          </div>
        </div>

        <div style={{ padding:"18px 20px 0", overflowY:"auto", flex:1 }}>
          {!isSnack && (
            <>
              <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", marginBottom:10 }}>HOW MUCH DID YOU EAT?</div>
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:18 }}>
                {RATINGS.map(r => {
                  const sel = rating === r.id;
                  const xp = XP_RATING[r.id];
                  return (
                    <button key={r.id} onClick={()=>setRating(r.id)}
                      style={{ background:sel?theme.accent:"#fafafa", color:sel?"white":"#333", border:sel?"none":"2px solid #f0f0f0", borderRadius:18, padding:"14px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:12, fontFamily:"'Nunito',sans-serif", textAlign:"left" }}>
                      <div style={{ fontSize:30 }}>{r.emoji}</div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:15, fontWeight:900 }}>{r.label}</div>
                        <div style={{ fontSize:12, fontWeight:700, opacity:0.75 }}>{r.desc}</div>
                      </div>
                      <div style={{ fontSize:13, fontWeight:900, opacity:0.85 }}>+{xp} XP</div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
            {canBeNew && (
              <button onClick={()=>setWasNew(w=>!w)}
                style={{ flex:1, background:wasNew?"linear-gradient(135deg,#FFD700,#FFA500)":"white", color:wasNew?"#5a4000":"#B8860B", border:wasNew?"none":"2.5px dashed #FFB300", borderRadius:16, padding:"12px 8px", cursor:"pointer", fontSize:13, fontWeight:900, fontFamily:"'Nunito',sans-serif", boxShadow:wasNew?"0 4px 14px rgba(255,165,0,0.45)":"none", animation:wasNew?"none":"sparklePulse 1.6s ease-in-out infinite" }}>
                <span style={{ fontSize:16, marginRight:4 }}>{wasNew ? "🌟" : "✨"}</span>
                {wasNew ? "First time! +25 XP" : "Never tried before?"}
              </button>
            )}
            <button onClick={()=>fileRef.current?.click()} disabled={uploading}
              style={{ flex:1, background:photoId?theme.light:"#fafafa", color:photoId?theme.accent:"#999", border:photoId?`2px solid ${theme.accent}`:"2px solid #f0f0f0", borderRadius:16, padding:"12px", cursor:"pointer", fontSize:13, fontWeight:900, fontFamily:"'Nunito',sans-serif" }}>
              {uploading ? "⟳ Saving…" : photoId ? "📷 Photo added! +2 XP" : "📷 Add photo"}
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display:"none" }}/>
          </div>

          {photoPreview && (
            <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}>
              <img src={photoPreview} alt="" style={{ width:140, height:140, objectFit:"cover", borderRadius:18 }}/>
            </div>
          )}
        </div>

        <div style={{ padding:"0 20px" }}>
          <PrimaryButton onClick={()=>onSave({ rating: rating || "all", wasNew, photoId, xpEarned: xpPreview })}
            color={theme.accent} disabled={(!isSnack && !rating) || uploading} style={{ width:"100%" }}>
            Log it · +{xpPreview} XP 🎉
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ── Day detail popup ──────────────────────────────────────────────────────────
function DayDetailPanel({ user, date, library, logs, theme, onClose }) {
  const dayLogs = Object.entries(logs)
    .filter(([k]) => k.startsWith(`${user.id}-${date}-`))
    .map(([k, v]) => ({ ...v, slot: k.split("-").slice(-1)[0].startsWith("snack") ? "snack" : k.split("-").slice(-1)[0] }));

  const userLib = library[user.id] || [];
  const findFood = id => userLib.find(f => f.foodId === id);

  const totalXp = dayLogs.reduce((s, l) => s + (l.xpEarned || 0), 0);

  return (
    <>
      <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:80 }}/>
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:430, background:"white", borderRadius:"28px 28px 0 0", zIndex:90, padding:"0 0 32px", boxShadow:"0 -8px 40px rgba(0,0,0,0.18)", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)", maxHeight:"80vh", display:"flex", flexDirection:"column" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 16px", borderBottom:"1px solid #f0f0f0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontWeight:900, fontSize:17, color:"#333" }}>{friendlyDate(date)}</div>
            <div style={{ fontSize:13, color:"#bbb", fontWeight:600, marginTop:2 }}>
              {dayLogs.length} {dayLogs.length === 1 ? "log" : "logs"} · {totalXp} XP
            </div>
          </div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
        </div>

        <div style={{ padding:"12px 20px", overflowY:"auto", flex:1 }}>
          {dayLogs.length === 0 ? (
            <div style={{ textAlign:"center", padding:"32px 0", color:"#bbb", fontSize:13, fontWeight:700 }}>Nothing logged this day</div>
          ) : dayLogs.map((log, idx) => {
            const food = findFood(log.foodId);
            const ratingMeta = RATINGS.find(r => r.id === log.rating);
            return (
              <div key={idx} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", background:"#fafafa", borderRadius:14, marginBottom:8 }}>
                <PhotoThumb photoId={log.photoId || food?.heroPhotoId} size={48} fallback={food?.emoji || "🍽️"} radius={12}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11, fontWeight:800, color:"#bbb", letterSpacing:1 }}>{log.slot.toUpperCase()}</div>
                  <div style={{ fontSize:14, fontWeight:800, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{food?.name || "Unknown"}</div>
                  <div style={{ fontSize:11, fontWeight:700, color:theme.accent, marginTop:2 }}>
                    {ratingMeta && `${ratingMeta.emoji} ${ratingMeta.label} · `}+{log.xpEarned} XP {log.wasNew && "✨"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Week view screen ──────────────────────────────────────────────────────────
function WeekScreen({ user, library, plans, logs, theme, onBack }) {
  const [weekOffset, setWeekOffset] = useState(0); // -1 = last week, 0 = this, +1 = next
  const todayIso     = today();
  const baseMonday   = mondayOf(todayIso);
  const weekStart    = isoDateAddDays(baseMonday, weekOffset * 7);
  const days         = daysOfWeek(weekStart);
  const [dayDetail, setDayDetail] = useState(null);

  const userLib = library[user.id] || [];
  const findFood = id => userLib.find(f => f.foodId === id);

  return (
    <div style={{ minHeight:"100vh", background:theme.light, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", paddingBottom:40 }}>
      <div style={{ background:theme.accent, borderRadius:"0 0 36px 36px", padding:"20px 20px 28px", color:"white", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:`0 8px 30px ${theme.accent}55` }}>
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <div style={{ fontWeight:900, fontSize:20 }}>📅 {user.name}'s Week</div>
        <div style={{ width:60 }}/>
      </div>

      <div style={{ padding:"16px 16px 0" }}>
        <div style={{ display:"flex", gap:6, marginBottom:14, background:"white", padding:6, borderRadius:16, boxShadow:"0 4px 14px rgba(0,0,0,0.05)" }}>
          {[
            { id:-1, label:"Last week" },
            { id:0,  label:"This week" },
            { id:1,  label:"Next week" },
          ].map(t => (
            <button key={t.id} onClick={()=>setWeekOffset(t.id)}
              style={{ flex:1, background:weekOffset===t.id?theme.accent:"transparent", color:weekOffset===t.id?"white":"#999", border:"none", borderRadius:11, padding:"10px", fontSize:12, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
              {t.label}
            </button>
          ))}
        </div>

        {days.map(date => {
          const isToday = date === todayIso;
          const dayLogs = ["breakfast","lunch","dinner"].map(slot => {
            return { slot, log: logs[`${user.id}-${date}-${slot}`] };
          });
          const totalXp = Object.entries(logs)
            .filter(([k]) => k.startsWith(`${user.id}-${date}-`))
            .reduce((s, [_,v]) => s + (v.xpEarned || 0), 0);
          const completed = dayLogs.filter(d => d.log).length;
          const hasAny = totalXp > 0;

          return (
            <div key={date} onClick={() => hasAny && setDayDetail(date)}
              style={{ background:"white", borderRadius:18, padding:"12px 14px", marginBottom:8, boxShadow:"0 2px 8px rgba(0,0,0,0.04)", border:isToday?`2px solid ${theme.accent}`:"2px solid transparent", cursor:hasAny?"pointer":"default", opacity:hasAny?1:0.7 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                <div style={{ fontWeight:900, fontSize:14, color:isToday?theme.accent:"#333" }}>
                  {friendlyDate(date)} {isToday && "· Today"}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:"#999" }}>{completed}/3</div>
                  {totalXp > 0 && (
                    <div style={{ background:theme.light, color:theme.accent, padding:"2px 8px", borderRadius:8, fontSize:11, fontWeight:900 }}>+{totalXp} XP</div>
                  )}
                </div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                {dayLogs.map(({slot, log}) => {
                  const planEntry = !log ? plans[`${user.id}-${date}-${slot}`] : null;
                  const planned = !log && !!planEntry;
                  const food = log ? findFood(log.foodId) : (planEntry ? findFood(planEntry.foodId) : null);
                  return (
                    <div key={slot} style={{ flex:1, background:log?theme.light:planned?"rgba(255,255,255,0.7)":"#fafafa", borderRadius:10, padding:"6px", display:"flex", alignItems:"center", gap:6, minWidth:0, border: planned ? `2px dashed ${theme.accent}66` : "2px solid transparent", boxSizing:"border-box" }}>
                      <PhotoThumb photoId={log?.photoId || food?.heroPhotoId} size={28} fallback={food?.emoji || SLOTS.find(s=>s.id===slot)?.emoji} radius={6}/>
                      <div style={{ minWidth:0, flex:1 }}>
                        <div style={{ fontSize:9, fontWeight:800, color:"#bbb", letterSpacing:0.5 }}>{slot.slice(0,4).toUpperCase()}</div>
                        <div style={{ fontSize:11, fontWeight:700, color:log?"#333":planned?theme.dark:"#bbb", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                          {food?.name || "—"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {dayDetail && <DayDetailPanel user={user} date={dayDetail} library={library} logs={logs} theme={theme} onClose={()=>setDayDetail(null)}/>}
    </div>
  );
}

// ── Library screen ────────────────────────────────────────────────────────────
function LibraryScreen({ user, library, logs, theme, onBack, onAddNew, onDeleteFood }) {
  const [filter, setFilter] = useState("all");
  const [confirmDel, setConfirmDel] = useState(null);
  const userLib = library[user.id] || [];

  let shown = userLib;
  if (filter === "tried")   shown = userLib.filter(f => f.tried);
  if (filter === "untried") shown = userLib.filter(f => !f.tried);

  const triedCount = userLib.filter(f => f.tried).length;

  return (
    <div style={{ minHeight:"100vh", background:theme.light, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", paddingBottom:40 }}>
      <div style={{ background:theme.accent, borderRadius:"0 0 36px 36px", padding:"20px 20px 28px", color:"white", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:`0 8px 30px ${theme.accent}55` }}>
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontWeight:900, fontSize:20 }}>📚 {user.name}'s Library</div>
          <div style={{ fontSize:12, opacity:0.85, fontWeight:700, marginTop:1 }}>
            {triedCount} tried · {userLib.length - triedCount} to try
          </div>
        </div>
        <GhostButton onClick={onAddNew} style={{ padding:"8px 12px" }}>+ New</GhostButton>
      </div>

      <div style={{ padding:"16px 16px 0" }}>
        <div style={{ display:"flex", gap:6, marginBottom:14, background:"white", padding:6, borderRadius:16, boxShadow:"0 4px 14px rgba(0,0,0,0.05)" }}>
          {[
            { id:"all",     label:"All" },
            { id:"tried",   label:"Tried" },
            { id:"untried", label:"Not yet" },
          ].map(f => (
            <button key={f.id} onClick={()=>setFilter(f.id)}
              style={{ flex:1, background:filter===f.id?theme.accent:"transparent", color:filter===f.id?"white":"#999", border:"none", borderRadius:11, padding:"10px", fontSize:12, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
              {f.label}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <div style={{ textAlign:"center", padding:"60px 20px", color:"#bbb", fontSize:13, fontWeight:700 }}>
            <div style={{ fontSize:48, marginBottom:12 }}>📚</div>
            {userLib.length === 0 ? (
              <>Your library is empty.<br/>Add foods as you eat them — earn 25 XP for every new food! ✨</>
            ) : "No foods in this filter."}
          </div>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {shown.sort((a,b)=>(b.timesEaten||0)-(a.timesEaten||0)).map(food => (
              <div key={food.foodId}
                onContextMenu={e=>{e.preventDefault();setConfirmDel(food);}}
                style={{ background:"white", borderRadius:18, padding:"12px 10px 10px", display:"flex", flexDirection:"column", alignItems:"center", gap:6, boxShadow:"0 2px 8px rgba(0,0,0,0.05)", position:"relative" }}>
                {!food.tried && (
                  <div style={{ position:"absolute", top:6, right:6, background:"#FFD700", borderRadius:8, padding:"2px 6px", fontSize:9, fontWeight:900, color:"#7a5a00" }}>NEW!</div>
                )}
                <PhotoThumb photoId={food.heroPhotoId} size={70} fallback={food.emoji} radius={14}/>
                <div style={{ fontSize:13, fontWeight:800, color:"#333", textAlign:"center", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:"100%" }}>{food.name}</div>
                <div style={{ fontSize:10, fontWeight:700, color:"#bbb" }}>
                  {food.timesEaten > 0 ? `${food.timesEaten}× eaten` : "Not tried yet"}
                </div>
                <button onClick={()=>setConfirmDel(food)} style={{ position:"absolute", bottom:6, right:6, background:"transparent", border:"none", color:"#ddd", fontSize:14, cursor:"pointer", padding:4 }}>🗑</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmDel && (
        <div onClick={()=>setConfirmDel(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:90, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:"white", borderRadius:24, padding:24, maxWidth:320, width:"100%" }}>
            <div style={{ fontSize:18, fontWeight:900, color:"#333", marginBottom:8 }}>Delete "{confirmDel.name}"?</div>
            <div style={{ fontSize:13, color:"#999", fontWeight:600, marginBottom:18 }}>This won't delete past logs of this food, just remove it from the library.</div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={()=>setConfirmDel(null)} style={{ flex:1, background:"#f5f5f5", border:"none", borderRadius:14, padding:"12px", fontSize:14, fontWeight:800, color:"#999", cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>Cancel</button>
              <button onClick={()=>{onDeleteFood(confirmDel.foodId); setConfirmDel(null);}} style={{ flex:1, background:"#E05555", border:"none", borderRadius:14, padding:"12px", fontSize:14, fontWeight:800, color:"white", cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings screen ───────────────────────────────────────────────────────────
function SettingsScreen({ user, onSave, onBack }) {
  const [name, setName]     = useState(user.name);
  const [animal, setAnimal] = useState(user.animal || "cat");
  const [themeId, setTheme] = useState(user.themeId || "teal");
  const [colorId, setColor] = useState(user.animalColorId || "mint");
  const [outfitId, setOutfit] = useState(user.outfitId || "none");
  const pt  = resolveTheme(themeId);
  const pac = resolveAnimal(colorId).color;
  const userLevel = user.level || 1;

  const handleSave = () => {
    onSave({ ...user, name: name.trim() || user.name, animal, themeId, animalColorId: colorId, outfitId });
  };

  return (
    <div style={{ minHeight:"100vh", background:pt.light, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", paddingBottom:56 }}>
      <div style={{ background:pt.accent, borderRadius:"0 0 36px 36px", padding:"20px 20px 28px", color:"white", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:`0 8px 30px ${pt.accent}55` }}>
        <GhostButton onClick={onBack}>← Back</GhostButton>
        <div style={{ fontWeight:900, fontSize:22 }}>⚙️ Settings</div>
        <GhostButton onClick={handleSave}>Save ✓</GhostButton>
      </div>

      <div style={{ padding:"24px 20px 0" }}>
        <SectionCard title="NAME">
          <input value={name} onChange={e=>setName(e.target.value)}
            style={{ width:"100%", border:`2px solid ${pt.accent}44`, borderRadius:14, padding:"12px 16px", fontSize:18, fontWeight:800, color:"#333", fontFamily:"'Nunito',sans-serif", outline:"none", boxSizing:"border-box", background:pt.light }}/>
        </SectionCard>

        <SectionCard title="THEME COLOUR">
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8 }}>
            {THEME_COLOURS.map(t => {
              const sel = t.id === themeId;
              return (
                <button key={t.id} onClick={()=>setTheme(t.id)}
                  style={{ border:`3px solid ${sel?"#333":"transparent"}`, borderRadius:14, padding:"8px 4px 6px", cursor:"pointer", background:"white", display:"flex", flexDirection:"column", alignItems:"center", gap:4, boxShadow:sel?"0 2px 10px rgba(0,0,0,0.18)":"0 1px 4px rgba(0,0,0,0.06)", transform:sel?"scale(1.06)":"scale(1)", transition:"transform 0.12s" }}>
                  <div style={{ width:30, height:30, borderRadius:10, background:t.accent, boxShadow:`0 3px 8px ${t.accent}55` }}/>
                  <div style={{ fontSize:9, fontWeight:800, color:sel?"#333":"#bbb" }}>{t.label}</div>
                </button>
              );
            })}
          </div>
        </SectionCard>

        <SectionCard title="PET ANIMAL">
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8, marginBottom:16 }}>
            {ANIMALS.map(a => {
              const sel = a.id === animal;
              return (
                <button key={a.id} onClick={()=>setAnimal(a.id)}
                  style={{ border:`2.5px solid ${sel?pt.accent:"#eee"}`, background:sel?pt.light:"white", borderRadius:18, padding:"10px 4px 8px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                  <div style={{ fontSize:24 }}>{a.emoji}</div>
                  <div style={{ fontSize:9, fontWeight:800, color:sel?pt.accent:"#bbb" }}>{a.label}</div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", marginBottom:10 }}>ANIMAL COLOUR</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8 }}>
            {ANIMAL_COLOURS.map(c => {
              const sel = c.id === colorId;
              return (
                <button key={c.id} onClick={()=>setColor(c.id)}
                  style={{ border:`3px solid ${sel?"#333":"transparent"}`, borderRadius:14, padding:"8px 4px 6px", cursor:"pointer", background:"white", display:"flex", flexDirection:"column", alignItems:"center", gap:4, boxShadow:sel?"0 2px 10px rgba(0,0,0,0.18)":"0 1px 4px rgba(0,0,0,0.06)" }}>
                  <div style={{ width:30, height:30, borderRadius:"50%", background:c.color, boxShadow:`0 3px 8px ${c.color}55` }}/>
                  <div style={{ fontSize:9, fontWeight:800, color:sel?"#333":"#bbb" }}>{c.label}</div>
                </button>
              );
            })}
          </div>
          <div style={{ display:"flex", justifyContent:"center", marginTop:18, padding:"14px", background:pt.light, borderRadius:18, border:`2px solid ${pt.accent}22` }}>
            <div style={{ animation:"float 3s ease-in-out infinite" }}>
              <AnimalFace animal={animal} pct={0.85} color={pac} size={90} outfit={outfitId}/>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="OUTFIT" hint={`Unlock more outfits as you level up · ${outfitsUnlocked(userLevel).length}/${OUTFITS.length} unlocked`}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
            {OUTFITS.map(o => {
              const unlocked = userLevel >= o.level;
              const sel = outfitId === o.id;
              return (
                <button key={o.id} onClick={()=>unlocked && setOutfit(o.id)} disabled={!unlocked}
                  style={{ background:sel?pt.accent:unlocked?"white":"#fafafa", color:sel?"white":unlocked?"#333":"#bbb", border:sel?"none":`2px solid ${unlocked?pt.accent+"33":"#eee"}`, borderRadius:16, padding:"10px 6px", cursor:unlocked?"pointer":"default", fontFamily:"'Nunito',sans-serif", display:"flex", flexDirection:"column", alignItems:"center", gap:4, position:"relative", opacity:unlocked?1:0.55 }}>
                  <div style={{ width:54, height:54, position:"relative" }}>
                    {unlocked ? (
                      <AnimalFace animal={animal} pct={1} color={pac} size={54} outfit={o.id}/>
                    ) : (
                      <div style={{ width:54, height:54, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, background:"#f0f0f0", borderRadius:14 }}>🔒</div>
                    )}
                  </div>
                  <div style={{ fontSize:11, fontWeight:900, marginTop:2, textAlign:"center", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:"100%" }}>{o.label}</div>
                  <div style={{ fontSize:10, fontWeight:700, opacity:0.7 }}>{unlocked ? (o.level === 0 ? "Default" : `LV ${o.level}`) : `LV ${o.level}`}</div>
                </button>
              );
            })}
          </div>
        </SectionCard>

        <PrimaryButton onClick={handleSave} color={pt.accent} style={{ width:"100%" }}>
          Save Changes ✓
        </PrimaryButton>
      </div>
    </div>
  );
}

// ── Select screen ─────────────────────────────────────────────────────────────
function SelectScreen({ users, logs, library, theme0, onSelect, onSettings, onPlanner }) {
  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(160deg,#1a0d2e 0%,#1e1a3e 55%,#0d1a2e 100%)", display:"flex", flexDirection:"column", fontFamily:"'Nunito',sans-serif", position:"relative", overflow:"hidden" }}>
      {["🍎","🥕","🍕","🥗","🍇","🍓"].map((e,i) => (
        <div key={i} style={{ position:"absolute", fontSize:30, opacity:0.13, top:`${[12,22,68,78,42,55][i]}%`, left:`${[4,82,6,78,48,30][i]}%`, animation:`float ${2.5+i*0.4}s ease-in-out infinite`, animationDelay:`${i*0.5}s`, pointerEvents:"none" }}>{e}</div>
      ))}

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"20px 22px 8px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:18 }}>🍽️</span>
          <span style={{ fontSize:15, fontWeight:900, color:"rgba(255,255,255,0.65)", letterSpacing:-0.3 }}>The Daily Food</span>
        </div>
        <span style={{ fontSize:11, color:"rgba(255,255,255,0.3)", fontWeight:700 }}>{friendlyDate(today())}</span>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"center", padding:"12px 18px 28px" }}>
        <p style={{ color:"rgba(255,255,255,0.4)", fontSize:13, fontWeight:700, margin:"0 0 18px", textAlign:"center", letterSpacing:0.5 }}>Who's eating today?</p>

        {users.map((u, idx) => {
          const ut       = userTheme(u);
          const aColor   = userAColor(u);
          const userLogs = Object.entries(logs).filter(([k]) => k.startsWith(`${u.id}-${today()}-`));
          const slotsDone = ["breakfast","lunch","dinner"].map(s => !!logs[`${u.id}-${today()}-${s}`]);
          const completed = slotsDone.filter(Boolean).length;
          const animalInfo = ANIMALS.find(a => a.id === (u.animal || "cat"));
          const { lvl, current, needed, pct } = xpProgressInLevel(u.totalXp || 0);

          return (
            <div key={u.id} style={{ marginBottom: idx<users.length-1?16:0, animation:`pop 0.4s ease ${idx*0.12}s both`, position:"relative" }}>
              <div onClick={()=>onSelect(u)}
                style={{ background:"rgba(255,255,255,0.09)", border:"1.5px solid rgba(255,255,255,0.13)", backdropFilter:"blur(16px)", borderRadius:32, padding:"22px 20px", cursor:"pointer", display:"flex", alignItems:"center", gap:18 }}
                onMouseDown={e=>e.currentTarget.style.transform="scale(0.97)"} onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
                onTouchStart={e=>e.currentTarget.style.transform="scale(0.97)"} onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>

                <div style={{ width:80, height:80, borderRadius:"50%", background:ut.light, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, border:`3px solid ${ut.accent}55`, boxShadow:`0 0 22px ${ut.accent}33`, position:"relative" }}>
                  <AnimalFace animal={u.animal||"cat"} pct={completed/3} color={aColor} size={66} outfit={u.outfitId||"none"}/>
                  <div style={{ position:"absolute", bottom:-6, right:-6, background:ut.accent, color:"white", borderRadius:12, padding:"3px 9px", fontSize:11, fontWeight:900, border:"2px solid #1a1a3e", boxShadow:`0 2px 8px ${ut.accent}88` }}>LV {lvl}</div>
                </div>

                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <div style={{ fontWeight:900, fontSize:24, color:"white", letterSpacing:-0.5 }}>{u.name}</div>
                    <div style={{ fontSize:18 }}>{animalInfo?.emoji}</div>
                  </div>

                  <div style={{ display:"flex", gap:5, marginBottom:8 }}>
                    {SLOTS.map((s, i) => (
                      <div key={s.id} style={{ flex:1, height:8, borderRadius:4, background:slotsDone[i]?"#4CAF85":"rgba(255,255,255,0.13)", boxShadow:slotsDone[i]?"0 0 8px #4CAF8588":"none" }}/>
                    ))}
                  </div>

                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <div style={{ fontSize:12, color:"rgba(255,255,255,0.5)", fontWeight:700 }}>
                      {completed}/3 meals · {current}/{needed} XP
                    </div>
                    <div style={{ background:ut.accent, borderRadius:12, padding:"3px 10px", fontWeight:900, fontSize:12, color:"white" }}>
                      {Math.round(pct*100)}%
                    </div>
                  </div>
                </div>
              </div>

              <button onClick={e=>{e.stopPropagation(); onPlanner(u);}}
                aria-label={`${u.name}'s planner`}
                style={{ position:"absolute", top:-6, left:-6, width:36, height:36, borderRadius:"50%", background:"rgba(255,255,255,0.14)", border:"1.5px solid rgba(255,255,255,0.25)", color:"white", fontSize:15, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(8px)" }}>
                📋
              </button>

              <button onClick={e=>{e.stopPropagation(); onSettings(u);}}
                aria-label={`${u.name}'s settings`}
                style={{ position:"absolute", top:-6, right:-6, width:36, height:36, borderRadius:"50%", background:"rgba(255,255,255,0.14)", border:"1.5px solid rgba(255,255,255,0.25)", color:"white", fontSize:15, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(8px)" }}>
                ⚙️
              </button>
            </div>
          );
        })}
      </div>

      <p style={{ color:"rgba(255,255,255,0.18)", fontSize:11, textAlign:"center", margin:"0 0 16px", fontWeight:600 }}>☁️ Cloud sync enabled · v{APP_VERSION}</p>
    </div>
  );
}

// ── Today screen (main) ───────────────────────────────────────────────────────
function TodayScreen({ user, library, plans, logs, theme, aColor, onBack, onLog, onSlotAction, onAddNew, onLibrary, onWeek, onSettings, onDeleteLog, onIsland }) {
  const todayIso = today();
  const userLib = library[user.id] || [];
  const findFood = id => userLib.find(f => f.foodId === id);
  const animalInfo = ANIMALS.find(a => a.id === (user.animal || "cat"));

  const slotData = SLOTS.map(slot => {
    const log = logs[`${user.id}-${todayIso}-${slot.id}`];
    const planEntry = plans[`${user.id}-${todayIso}-${slot.id}`];
    const planFoodId = planEntry?.foodId || null;
    return {
      slot,
      log,
      plan: planFoodId,
      food: log ? findFood(log.foodId) : (planFoodId ? findFood(planFoodId) : null),
    };
  });

  const completed = slotData.filter(s => s.log).length;
  const todayXp = Object.entries(logs)
    .filter(([k]) => k.startsWith(`${user.id}-${todayIso}-`))
    .reduce((s, [_, v]) => s + (v.xpEarned || 0), 0);

  const snackLogs = Object.entries(logs)
    .filter(([k]) => k.startsWith(`${user.id}-${todayIso}-snack`))
    .map(([k, v]) => ({ key: k, log: v }));

  // Animal mood reflects daily progress
  const moodPct = completed / 3;
  const tod = useTimeOfDay();

  return (
    <div style={{ minHeight:"100vh", background:theme.light, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", paddingBottom:40 }}>
      <div style={{ background:theme.accent, borderRadius:"0 0 36px 36px", padding:"18px 18px 24px", color:"white", boxShadow:`0 8px 30px ${theme.accent}55` }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <GhostButton onClick={onBack}>← Back</GhostButton>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontWeight:900, fontSize:20 }}>{user.name} {animalInfo?.emoji}</div>
            <div style={{ fontSize:11, opacity:0.85, fontWeight:700, marginTop:1 }}>{friendlyDate(todayIso)}</div>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            <GhostButton onClick={onLibrary} style={{ padding:"8px 12px" }}>📚</GhostButton>
            <GhostButton onClick={onWeek}    style={{ padding:"8px 12px" }}>📅</GhostButton>
            <GhostButton onClick={onSettings}style={{ padding:"8px 12px" }}>⚙️</GhostButton>
          </div>
        </div>

        <div style={{ background:"rgba(255,255,255,0.95)" }}>
          <XpBar totalXp={user.totalXp || 0} color={theme.accent} light={theme.light}/>
        </div>
      </div>

      {/* Animal */}
      <div style={{ display:"flex", justifyContent:"center", padding:"20px 0 12px" }}>
        <LiveAnimal
          animal={user.animal||"cat"}
          color={aColor}
          outfit={user.outfitId||"none"}
          pct={moodPct}
          size={130}
          tod={tod}
          mealState={completed === 3 ? "full" : completed === 0 ? "empty" : "partial"}
          context="today"
        />
      </div>

      <div style={{ textAlign:"center", padding:"0 20px 16px" }}>
        <div style={{ fontSize:14, fontWeight:800, color:theme.dark }}>
          {completed === 3 ? "Perfect day! 🌟" :
           completed === 2 ? "Almost there!" :
           completed === 1 ? "Good start!" :
           "Let's eat something!"}
        </div>
        {todayXp > 0 && (
          <div style={{ fontSize:12, fontWeight:700, color:theme.accent, marginTop:2 }}>
            +{todayXp} XP today
          </div>
        )}
      </div>

      {/* Slots */}
      <div style={{ padding:"0 16px" }}>
        <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", margin:"0 6px 10px" }}>TODAY'S MEALS</div>
        {slotData.map(({slot, log, plan, food}) => (
          <SlotCard key={slot.id} slot={slot} log={log} plan={plan} food={food} color={theme.accent} dark={theme.dark} light={theme.light}
            onTap={()=>{
              if (log) onSlotAction(slot.id, log, food);
              else     onLog(slot.id);
            }}/>
        ))}
      </div>

      {/* Snacks */}
      <div style={{ padding:"6px 16px 0" }}>
        <div style={{ background:"white", borderRadius:22, padding:"14px 16px", boxShadow:"0 4px 18px rgba(0,0,0,0.05)" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:snackLogs.length?10:0 }}>
            <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb" }}>
              SNACKS {snackLogs.length>0 && `· ${snackLogs.length}`}
            </div>
            <button onClick={()=>onLog("snack")}
              style={{ background:theme.accent, color:"white", border:"none", borderRadius:12, padding:"6px 14px", fontSize:12, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
              + Snack
            </button>
          </div>
          {snackLogs.length === 0 ? null : snackLogs.map(({key, log}) => (
            <SnackRow key={key} log={log} food={findFood(log.foodId)} color={theme.accent} light={theme.light} onDelete={()=>onDeleteLog(key)}/>
          ))}
        </div>
      </div>

      {/* Island thumbnail */}
      <div style={{ padding:"14px 16px 0" }}>
        <IslandThumbnailButton user={user} aColor={aColor} theme={theme}
          level={user.level||1} totalXp={user.totalXp||0} onTap={onIsland}/>
      </div>
    </div>
  );
}

// ── Planner: slot cell ────────────────────────────────────────────────────────
function PlannerSlotCell({ slot, food, isPast, planned, theme, onTap }) {
  return (
    <div onClick={isPast ? undefined : onTap}
      style={{
        background: planned ? "white" : "rgba(255,255,255,0.55)",
        borderRadius:18,
        padding:"10px 12px",
        marginBottom:6,
        cursor: isPast ? "default" : "pointer",
        display:"flex",
        alignItems:"center",
        gap:12,
        boxShadow: planned ? "0 2px 8px rgba(0,0,0,0.05)" : "none",
        border: planned ? "2px solid transparent" : `2px dashed ${theme.accent}55`,
        boxSizing:"border-box",
        transition:"transform 0.1s",
      }}
      onMouseDown={isPast?undefined:e=>e.currentTarget.style.transform="scale(0.985)"}
      onMouseUp={isPast?undefined:e=>e.currentTarget.style.transform="scale(1)"}
      onTouchStart={isPast?undefined:e=>e.currentTarget.style.transform="scale(0.985)"}
      onTouchEnd={isPast?undefined:e=>e.currentTarget.style.transform="scale(1)"}>

      <div style={{ width:44, height:44, borderRadius:12, background: planned ? theme.light : "transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:22 }}>
        {food && food.heroPhotoId ? (
          <PhotoThumb photoId={food.heroPhotoId} size={44} radius={12}/>
        ) : food ? food.emoji : slot.emoji}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:10, fontWeight:800, letterSpacing:1, color:"#bbb" }}>{slot.label.toUpperCase()}</div>
        <div style={{ fontSize:14, fontWeight:planned?900:700, color: planned ? "#333" : "#aaa", marginTop:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
          {planned ? (food?.name || "Unknown food") : (isPast ? "—" : "Tap to plan")}
        </div>
      </div>
      {!isPast && <div style={{ fontSize:18, color: planned ? "#ccc" : theme.accent + "99", fontWeight:900 }}>{planned ? "›" : "+"}</div>}
    </div>
  );
}

// ── Planner: day row (one date, three slots) ─────────────────────────────────
function PlannerDayRow({ user, date, todayIso, library, plans, theme, onCellTap }) {
  const isToday = date === todayIso;
  const isPast = date < todayIso;
  const userLib = library[user.id] || [];
  const findFood = id => userLib.find(f => f.foodId === id);

  const dt = new Date(date + "T12:00:00");
  const wkday  = dt.toLocaleDateString("en-GB", { weekday: "short" });
  const daymon = dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <div style={{ marginBottom:14, opacity: isPast ? 0.5 : 1 }}>
      <div style={{ display:"flex", alignItems:"baseline", gap:8, padding:"0 4px 8px" }}>
        <div style={{ fontSize:14, fontWeight:900, color: isToday ? theme.accent : "#555" }}>
          {wkday}
        </div>
        <div style={{ fontSize:11, fontWeight:700, color:"#999" }}>{daymon}</div>
        {isToday && (
          <div style={{ background:theme.accent, color:"white", borderRadius:8, padding:"1px 8px", fontSize:9, fontWeight:900, letterSpacing:0.5 }}>TODAY</div>
        )}
        {isPast && (
          <div style={{ marginLeft:"auto", fontSize:10, fontWeight:700, color:"#bbb", letterSpacing:0.5 }}>past · view only</div>
        )}
      </div>
      {SLOTS.map(slot => {
        const planEntry = plans[`${user.id}-${date}-${slot.id}`];
        const food = planEntry ? findFood(planEntry.foodId) : null;
        return (
          <PlannerSlotCell key={slot.id} slot={slot} food={food}
            isPast={isPast} planned={!!planEntry} theme={theme}
            onTap={() => onCellTap(date, slot.id)}/>
        );
      })}
    </div>
  );
}

// ── Planner: action menu (tap a planned cell) ────────────────────────────────
function PlanActionMenu({ actionCtx, theme, onMove, onChange, onRemove, onClose }) {
  const { food, slot, date } = actionCtx;
  const slotLabel = SLOTS.find(s=>s.id===slot)?.label.toUpperCase();
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:88, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", animation:"slideUp 0.25s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 16px", borderBottom:"1px solid #f0f0f0", display:"flex", alignItems:"center", gap:14 }}>
          <PhotoThumb photoId={food?.heroPhotoId} size={56} fallback={food?.emoji || "🍽️"} radius={16}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:11, fontWeight:800, letterSpacing:1, color:"#bbb" }}>
              {slotLabel} · {friendlyDate(date)}
            </div>
            <div style={{ fontSize:17, fontWeight:900, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
              {food?.name || "Unknown food"}
            </div>
          </div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
        </div>

        <div style={{ padding:"16px 20px 0", display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={onMove}
            style={{ width:"100%", background:theme.accent, color:"white", border:"none", borderRadius:16, padding:"14px", fontSize:15, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:`0 4px 14px ${theme.accent}55`, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            ↔️ Move to another day
          </button>
          <button onClick={onChange}
            style={{ width:"100%", background:theme.light, color:theme.accent, border:`2px solid ${theme.accent}33`, borderRadius:16, padding:"12px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            🔄 Change food
          </button>
          <button onClick={onRemove}
            style={{ width:"100%", background:"white", color:"#E05555", border:"2px solid #FFE0E0", borderRadius:16, padding:"12px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            🗑️ Remove plan
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Island module ─────────────────────────────────────────────────────────────
// Each kid earns a personal island that grows as they level up. Tier elements
// are positioned in a wide SVG that can be scrolled horizontally on the
// IslandScreen. A miniature live preview of the same island also serves as
// the entry-point button on the Today screen.

const ISLAND_TIERS = [
  { id:"tree1",      level:2,  label:"First tree",     hint:"A young tree takes root." },
  { id:"pond",       level:4,  label:"Pond",           hint:"A clear blue pond with sparkles." },
  { id:"friend1",    level:6,  label:"Friend animal",  hint:"A friend comes to live here." },
  { id:"hut",        level:9,  label:"Cozy hut",       hint:"A little wooden hut with a smoking chimney." },
  { id:"friend2",    level:12, label:"Second friend",  hint:"Another friend joins the island." },
  { id:"bridge",     level:15, label:"Bridge",         hint:"A footbridge spans the pond." },
  { id:"mountain",   level:18, label:"Mountain",       hint:"A snow-capped peak rises behind." },
  { id:"boat",       level:22, label:"Boat",           hint:"A little boat bobs on the water." },
  { id:"lighthouse", level:26, label:"Lighthouse",     hint:"A lighthouse guides the way home." },
  { id:"jungle",     level:30, label:"Jungle isle",    hint:"A second island appears." },
];

const islandTierUnlocked   = (level, tierId) => {
  const t = ISLAND_TIERS.find(t => t.id === tierId);
  return !!t && level >= t.level;
};
const islandUnlockedCount  = (level) => ISLAND_TIERS.filter(t => level >= t.level).length;
const islandNextTier       = (level) => ISLAND_TIERS.find(t => level < t.level) || null;

// ── Island: time-of-day helpers ──────────────────────────────────────────────
// Locked to real device clock. Five phases drive sky gradients, sun position,
// star visibility, and lighthouse beam strength. Updates every minute so the
// transitions are gradual but the kid sees changes within a session.
//
// dawn   05:00–07:00  pink/peach
// day    07:00–18:00  blue
// dusk   18:00–20:00  orange/purple
// night  20:00–05:00  navy + stars
function useTimeOfDay() {
  const [tod, setTod] = useState(() => computeTod());
  useEffect(() => {
    const id = setInterval(() => setTod(computeTod()), 60000);
    return () => clearInterval(id);
  }, []);
  return tod;
}

function computeTod() {
  const h = new Date().getHours();
  if (h >= 5  && h < 7)  return "dawn";
  if (h >= 7  && h < 18) return "day";
  if (h >= 18 && h < 20) return "dusk";
  return "night";
}

const TOD_THEMES = {
  dawn:  { sky:["#FFC4A8","#FFD9B8","#FFE9C5"],  sea:["#7BAEDB","#3498DB"],  sunY:240, sunFill:"#FFB07A", sunGlow:"#FFD8B5", stars:false, beam:0.3 },
  day:   { sky:["#A8DDF0","#D4F0FB","#FCE9C5"],  sea:["#5DADE2","#3498DB"],  sunY:100, sunFill:"#FFE08A", sunGlow:"#FFE08A", stars:false, beam:0.0 },
  dusk:  { sky:["#FF8A6B","#FFB084","#5C3F7C"],  sea:["#5C5C8C","#3D3D6E"],  sunY:340, sunFill:"#FF8050", sunGlow:"#FFB07A", stars:false, beam:0.7 },
  night: { sky:["#0E1B3A","#1E2A5C","#2E3D75"],  sea:["#1F3A60","#0E1B3A"],  sunY:90,  sunFill:"#E6E6FF", sunGlow:"#9CA8D6", stars:true,  beam:1.0 },
};

// ── Island: tier element renderers ───────────────────────────────────────────
// Each function returns a pure SVG <g> at a given x,y. `scale` multiplies the
// element's intrinsic size — used by the miniature preview to shrink everything
// uniformly. Animations are CSS-driven (declared in the global CSS block).
// Each function returns a pure SVG <g> at a given x,y. `scale` multiplies the
// element's intrinsic size — used by the miniature preview to shrink everything
// uniformly. Animations are CSS-driven (declared in the global CSS block).

function IslandTree({ x, y, scale=1 }) {
  // Tier 1 unlock = a small grove (3 trees) instead of a single tree, so the
  // first delivered moment feels worthwhile. Each tree wraps its sway
  // animation in an inner <g> so that the outer <g>'s static translate isn't
  // overwritten by the animation's keyframe transforms.
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      {/* Left tree (smaller, set back-left) */}
      <g transform="translate(-58,4) scale(0.75)">
        <g style={{ animation:"islandSway 4.6s ease-in-out infinite", transformOrigin:"50% 100%", transformBox:"fill-box" }}>
          <rect x="-6" y="-26" width="12" height="34" rx="3" fill="#7B5230"/>
          <ellipse cx="-12" cy="-44" rx="18" ry="18" fill="#5FBF5F"/>
          <ellipse cx="11"  cy="-48" rx="16" ry="16" fill="#6FCB6F"/>
          <ellipse cx="0"   cy="-60" rx="18" ry="18" fill="#7AD37A"/>
        </g>
      </g>
      {/* Centre tree (largest) */}
      <g style={{ animation:"islandSway 4s ease-in-out infinite 0.8s", transformOrigin:"50% 100%", transformBox:"fill-box" }}>
        <rect x="-7" y="-30" width="14" height="40" rx="4" fill="#7B5230"/>
        <ellipse cx="-15" cy="-50" rx="22" ry="22" fill="#5FBF5F"/>
        <ellipse cx="14"  cy="-55" rx="20" ry="20" fill="#6FCB6F"/>
        <ellipse cx="0"   cy="-70" rx="22" ry="22" fill="#7AD37A"/>
      </g>
      {/* Right tree (medium, set forward-right) */}
      <g transform="translate(60,2) scale(0.85)">
        <g style={{ animation:"islandSway 5.2s ease-in-out infinite 0.4s", transformOrigin:"50% 100%", transformBox:"fill-box" }}>
          <rect x="-6" y="-28" width="12" height="36" rx="3" fill="#7B5230"/>
          <ellipse cx="-13" cy="-46" rx="19" ry="19" fill="#5FBF5F"/>
          <ellipse cx="12"  cy="-50" rx="17" ry="17" fill="#6FCB6F"/>
          <ellipse cx="0"   cy="-62" rx="19" ry="19" fill="#7AD37A"/>
        </g>
      </g>
      {/* Small flowers at the base for charm */}
      <circle cx="-30" cy="6" r="2.2" fill="#FFD66B"/>
      <circle cx="-26" cy="9" r="2"   fill="#FF9FB2"/>
      <circle cx="32"  cy="7" r="2.2" fill="#FFD66B"/>
      <circle cx="38"  cy="10" r="2"  fill="#B5DEFF"/>
    </g>
  );
}

function IslandPond({ x, y, scale=1 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <ellipse cx="0" cy="2" rx="60" ry="13" fill="#3498DB" opacity="0.25"/>
      <ellipse cx="0" cy="0" rx="56" ry="11" fill="#5DADE2"/>
      <ellipse cx="0" cy="-2" rx="50" ry="9" fill="#85C1E9"/>
      <ellipse cx="-22" cy="-1" rx="6" ry="1.5" fill="white" opacity="0.7"
        style={{ animation:"islandRipple 2.8s ease-in-out infinite", transformOrigin:"50% 50%", transformBox:"fill-box" }}/>
      <ellipse cx="18"  cy="-3" rx="4" ry="1"   fill="white" opacity="0.55"
        style={{ animation:"islandRipple 2.4s ease-in-out infinite 0.6s", transformOrigin:"50% 50%", transformBox:"fill-box" }}/>
      {/* Lily pads */}
      <g style={{ animation:"islandLilyDrift 6s ease-in-out infinite", transformOrigin:"50% 50%", transformBox:"fill-box" }}>
        <ellipse cx="-30" cy="-3" rx="7" ry="3" fill="#3FA85F"/>
        <path d="M -30 -4 L -25 -4 L -27 -1 Z" fill="#2D8047"/>
        <circle cx="-32" cy="-5" r="1.5" fill="#FF9FB2"/>
      </g>
      <g style={{ animation:"islandLilyDrift 7s ease-in-out infinite 1.2s", transformOrigin:"50% 50%", transformBox:"fill-box" }}>
        <ellipse cx="28" cy="-4" rx="6" ry="2.5" fill="#4FB670"/>
        <circle cx="30" cy="-6" r="1.3" fill="#FFD66B"/>
      </g>
    </g>
  );
}

function IslandFriend({ x, y, scale=1, color="#FFB7B2", faceRight=false }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <g style={{ transform: faceRight ? "scaleX(-1)" : "scaleX(1)", transformOrigin:"0 0" }}>
        <g style={{ animation:"islandFriendBounce 1.8s ease-in-out infinite", transformOrigin:"50% 100%", transformBox:"fill-box" }}>
          <ellipse cx="0"  cy="-10" rx="16" ry="14" fill={color}/>
          <circle  cx="-6" cy="-12" r="2.5" fill="#333"/>
          <circle  cx="6"  cy="-12" r="2.5" fill="#333"/>
          <circle  cx="-5.3" cy="-12.7" r="0.8" fill="white"/>
          <circle  cx="6.7"  cy="-12.7" r="0.8" fill="white"/>
          <path d="M -3 -7 Q 0 -5 3 -7" stroke="#333" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
          <ellipse cx="-12" cy="-22" rx="4" ry="6" fill={color}/>
          <ellipse cx="12"  cy="-22" rx="4" ry="6" fill={color}/>
          <circle cx="-9" cy="-9" r="1.5" fill={color} stroke="#FF8A95" strokeWidth="0.4" opacity="0.7"/>
          <circle cx="9"  cy="-9" r="1.5" fill={color} stroke="#FF8A95" strokeWidth="0.4" opacity="0.7"/>
        </g>
      </g>
    </g>
  );
}

function IslandHut({ x, y, scale=1 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      {/* Veg patch beside the hut */}
      <ellipse cx="-44" cy="3" rx="18" ry="5" fill="#8B5A3C" opacity="0.6"/>
      <circle cx="-50" cy="0" r="3" fill="#E55A4F"/>
      <circle cx="-44" cy="-1" r="3" fill="#E55A4F"/>
      <circle cx="-38" cy="0" r="3" fill="#FFD66B"/>
      <rect x="-51" y="-7" width="1.5" height="6" fill="#3FA85F"/>
      <rect x="-45" y="-8" width="1.5" height="7" fill="#3FA85F"/>
      <rect x="-39" y="-7" width="1.5" height="6" fill="#3FA85F"/>
      {/* Stepping stones leading to door */}
      <ellipse cx="-15" cy="6" rx="4" ry="1.5" fill="#A89878"/>
      <ellipse cx="-5"  cy="5" rx="4" ry="1.5" fill="#A89878"/>
      <ellipse cx="5"   cy="6" rx="4" ry="1.5" fill="#A89878"/>
      {/* Hut body */}
      <rect x="-22" y="-30" width="44" height="32" rx="3" fill="#C9956B"/>
      <polygon points="-28,-30 28,-30 0,-58" fill="#8B5A3C"/>
      <rect x="-7" y="-18" width="14" height="20" rx="2" fill="#5C3D1F"/>
      <circle cx="4" cy="-7" r="1" fill="#FFE08A"/>
      <rect x="11" y="-25" width="8" height="8" rx="1" fill="#FFE08A"/>
      <line x1="15" y1="-25" x2="15" y2="-17" stroke="#5C3D1F" strokeWidth="0.6"/>
      <line x1="11" y1="-21" x2="19" y2="-21" stroke="#5C3D1F" strokeWidth="0.6"/>
      <rect x="6" y="-58" width="6" height="14" fill="#7B5230"/>
      <g style={{ animation:"islandSmoke 3s ease-in-out infinite" }}>
        <ellipse cx="9" cy="-66" rx="5" ry="4" fill="#E0E0E0" opacity="0.8"/>
        <ellipse cx="13" cy="-72" rx="3" ry="3" fill="#E0E0E0" opacity="0.6"/>
      </g>
    </g>
  );
}

function IslandBridge({ x, y, scale=1 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <path d="M -40 0 Q 0 -22 40 0" stroke="#8B5A3C" strokeWidth="6" fill="none" strokeLinecap="round"/>
      <path d="M -40 0 Q 0 -22 40 0" stroke="#A67248" strokeWidth="2" fill="none" strokeLinecap="round"/>
      <line x1="-30" y1="-7" x2="-30" y2="2" stroke="#5C3D1F" strokeWidth="2" strokeLinecap="round"/>
      <line x1="-12" y1="-17" x2="-12" y2="-8" stroke="#5C3D1F" strokeWidth="2" strokeLinecap="round"/>
      <line x1="12"  y1="-17" x2="12"  y2="-8" stroke="#5C3D1F" strokeWidth="2" strokeLinecap="round"/>
      <line x1="30"  y1="-7"  x2="30"  y2="2"  stroke="#5C3D1F" strokeWidth="2" strokeLinecap="round"/>
    </g>
  );
}

function IslandMountain({ x, y, scale=1 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <polygon points="-90,0 -10,-110 70,0" fill="#7A8B9C"/>
      <polygon points="-90,0 -10,-110 -30,0" fill="#5C6F84"/>
      <polygon points="-30,-66 -10,-110 12,-72 0,-58 -16,-72" fill="white"/>
    </g>
  );
}

function IslandBoat({ x, y, scale=1 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <g style={{ animation:"islandBoatBob 4.2s ease-in-out infinite", transformOrigin:"50% 80%", transformBox:"fill-box" }}>
        <path d="M -22 0 L 22 0 L 16 8 L -16 8 Z" fill="#C9534F"/>
        <rect x="-1" y="-26" width="2" height="26" fill="#7B5230"/>
        <polygon points="1,-25 14,-12 1,-12" fill="white"/>
        <polygon points="-1,-25 -12,-14 -1,-14" fill="#FFE08A"/>
      </g>
    </g>
  );
}

function IslandLighthouse({ x, y, scale=1, beamStrength=0 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <polygon points="-12,0 -8,-60 8,-60 12,0" fill="white"/>
      <rect x="-10" y="-22" width="20" height="6" fill="#E55A4F"/>
      <rect x="-10" y="-44" width="20" height="6" fill="#E55A4F"/>
      <rect x="-12" y="-65" width="24" height="6" fill="#5C3D1F"/>
      <rect x="-7" y="-78" width="14" height="14" fill="#FFE08A"/>
      <rect x="-7" y="-78" width="14" height="14" fill="#FFE08A"
        style={{ animation:"islandLightPulse 1.8s ease-in-out infinite", transformOrigin:"50% 50%", transformBox:"fill-box" }}/>
      {beamStrength > 0 && (
        <>
          <polygon points="-7,-72 -34,-66 -34,-78" fill="#FFE08A" opacity={0.5 * beamStrength}
            style={{ animation:"islandLightPulse 1.8s ease-in-out infinite", transformOrigin:"100% 50%", transformBox:"fill-box" }}/>
          <polygon points="7,-72 34,-66 34,-78" fill="#FFE08A" opacity={0.5 * beamStrength}
            style={{ animation:"islandLightPulse 1.8s ease-in-out infinite", transformOrigin:"0% 50%", transformBox:"fill-box" }}/>
          {/* Long projection beam at higher strength (dusk/night) */}
          {beamStrength >= 0.7 && (
            <>
              <polygon points="-7,-72 -150,-50 -150,-94" fill="#FFE08A" opacity={0.18 * beamStrength}
                style={{ animation:"islandLightPulse 1.8s ease-in-out infinite", transformOrigin:"100% 50%", transformBox:"fill-box" }}/>
              <polygon points="7,-72 150,-50 150,-94" fill="#FFE08A" opacity={0.18 * beamStrength}
                style={{ animation:"islandLightPulse 1.8s ease-in-out infinite", transformOrigin:"0% 50%", transformBox:"fill-box" }}/>
            </>
          )}
        </>
      )}
      <polygon points="-3,-86 3,-86 0,-94" fill="#5C3D1F"/>
    </g>
  );
}

function IslandJungle({ x, y, scale=1 }) {
  // A second mini-island with palm trees, sits to the far right.
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <ellipse cx="0" cy="0" rx="120" ry="18" fill="#E8D08C"/>
      <ellipse cx="0" cy="-6" rx="110" ry="13" fill="#7AD37A"/>
      <g style={{ animation:"islandSway 5s ease-in-out infinite", transformOrigin:"50% 100%", transformBox:"fill-box" }}>
        <rect x="-50" y="-50" width="6" height="50" fill="#7B5230"/>
        <ellipse cx="-65" cy="-55" rx="22" ry="6" fill="#5FBF5F"/>
        <ellipse cx="-30" cy="-58" rx="22" ry="6" fill="#5FBF5F"/>
        <ellipse cx="-47" cy="-65" rx="20" ry="6" fill="#7AD37A"/>
      </g>
      <g style={{ animation:"islandSway 4.5s ease-in-out infinite 0.5s", transformOrigin:"50% 100%", transformBox:"fill-box" }}>
        <rect x="40" y="-40" width="6" height="40" fill="#7B5230"/>
        <ellipse cx="22"  cy="-46" rx="20" ry="5" fill="#6FCB6F"/>
        <ellipse cx="62"  cy="-48" rx="20" ry="5" fill="#6FCB6F"/>
        <ellipse cx="42"  cy="-54" rx="18" ry="5" fill="#7AD37A"/>
      </g>
    </g>
  );
}

// ── Island: positions (canonical x,y for full-size scene) ────────────────────
// SVG viewBox is 1400x600 — scrolls horizontally. Ground line at y=500.
// Animal lives near centre-front. Order matters for z: items declared later
// render on top.
const ISLAND_POSITIONS = {
  mountain:   { x: 320,  y: 500 },     // back layer, behind ground line peeks up
  tree1:      { x: 480,  y: 500 },
  hut:        { x: 240,  y: 500 },
  friend1:    { x: 580,  y: 500 },
  pond:       { x: 800,  y: 510 },
  bridge:     { x: 800,  y: 503 },     // sits on top of pond
  friend2:    { x: 920,  y: 500 },
  boat:       { x: 720,  y: 510 },
  lighthouse: { x: 1080, y: 500 },
  jungle:     { x: 1280, y: 510 },
  animal:     { x: 660,  y: 470 },
};

// ── Time-of-day animal positions across the island ───────────────────────────
// x/y are the SVG translate coordinates for the <g> wrapper.
// At size=120, BODY_RATIO=1.85, the body is 120×222px.
// Positions chosen so feet (bottom of body) land near the ground at y≈490.
// foreignObject is anchored at (-60, 0) relative to the group so the body
// is centred horizontally; vertical offset -222 places feet at group.y+222.
const ANIMAL_TOD_POSITIONS = {
  dawn:  { x: 760,  y: 270 },   // pond edge — drinking
  day:   { x: 600,  y: 270 },   // centre island near tree
  dusk:  { x: 800,  y: 262 },   // on the bridge (slightly elevated)
  night: { x: 195,  y: 270 },   // beside hut door
};

// ── LiveAnimal ────────────────────────────────────────────────────────────────
// Shared component for the Today screen and the island. Renders the animal
// face with outfit, a periodic thought bubble, and tap-to-trick support.
// `context` = "today" | "island". Island version is embedded in SVG via
// foreignObject so we keep it as a plain div (works in both contexts).
const TRICKS = ["trickJump","trickWobble","trickShimmy","trickSpin","trickWave","trickDance"];
const TOD_THOUGHTS = {
  dawn:  ["Yawn… 🥱", "Morning! ☀️", "Stretch… 🌤️"],
  day:   ["Hungry! 🍎", "What's for lunch? 🍽️", "Let's eat! 😋"],
  dusk:  ["Nice sunset 🌅", "Almost dinner… 🍴", "Cozy evening ✨"],
  night: ["Zzz… 💤", "Sleepy… 🌙", "Sweet dreams 🌟"],
};
const MEAL_THOUGHTS = {
  full:    ["So full! 😊", "That was yummy! 💕", "Perfect day! 🌟"],
  partial: ["Still hungry… 🤔", "What's next? 🍽️", "Keep going! 💪"],
  empty:   ["Hungry! 🍎", "Feed me! 😅", "Time to eat! 🥄"],
};

function LiveAnimal({ animal, color, outfit, pct, size=130, tod, mealState="partial", context="today" }) {
  const [trick, setTrick]         = useState(null);   // null | CSS class name
  const [trickIdx, setTrickIdx]   = useState(0);
  const [bubble, setBubble]       = useState(null);   // null | string
  const [bubbleVisible, setBubbleVisible] = useState(false);
  const isNight = tod === "night";

  // Thought bubble cycle — every 12s pick a contextual message.
  useEffect(() => {
    const show = () => {
      const pool = mealState === "full"    ? MEAL_THOUGHTS.full
                 : mealState === "empty"   ? [...TOD_THOUGHTS[tod], ...MEAL_THOUGHTS.empty]
                 : [...TOD_THOUGHTS[tod],  ...MEAL_THOUGHTS.partial];
      const msg = pool[Math.floor(Math.random() * pool.length)];
      setBubble(msg);
      setBubbleVisible(true);
      setTimeout(() => setBubbleVisible(false), 3000);
    };
    // Initial delay so it doesn't fire immediately on mount.
    const init = setTimeout(show, 4000);
    const id   = setInterval(show, 12000);
    return () => { clearTimeout(init); clearInterval(id); };
  }, [tod, mealState]);

  const handleTap = () => {
    if (trick) return; // already animating
    const cls = TRICKS[trickIdx % TRICKS.length];
    setTrickIdx(i => i + 1);
    setTrick(cls);
    setTimeout(() => setTrick(null), 900);
  };

  // Base animation: night = slow pulse, dawn = dreamy slow float, else normal float.
  const baseAnim = isNight
    ? "nightBreath 4s ease-in-out infinite"
    : tod === "dawn"
    ? "float 5.5s ease-in-out infinite"
    : "float 3.5s ease-in-out infinite";

  const animalPct = isNight ? 0 : pct;

  return (
    <div onClick={handleTap}
      style={{ position:"relative", display:"inline-block", cursor:"pointer", userSelect:"none", WebkitUserSelect:"none" }}>

      {/* Thought bubble */}
      {bubble && (
        <div style={{
          position:"absolute", bottom:"100%", left:"50%",
          transform:"translateX(-50%)",
          marginBottom:8,
          background:"white",
          border:"2.5px solid #e0e0e0",
          borderRadius:18,
          padding:"6px 12px",
          fontSize:13,
          fontWeight:800,
          whiteSpace:"nowrap",
          fontFamily:"'Nunito',sans-serif",
          color:"#444",
          boxShadow:"0 4px 16px rgba(0,0,0,0.1)",
          opacity: bubbleVisible ? 1 : 0,
          transition:"opacity 0.5s ease",
          pointerEvents:"none",
          zIndex:10,
        }}>
          {bubble}
          {/* Bubble tail */}
          <div style={{ position:"absolute", bottom:-10, left:"50%", transform:"translateX(-50%)", width:0, height:0, borderLeft:"6px solid transparent", borderRight:"6px solid transparent", borderTop:"10px solid #e0e0e0" }}/>
          <div style={{ position:"absolute", bottom:-7, left:"50%", transform:"translateX(-50%)", width:0, height:0, borderLeft:"5px solid transparent", borderRight:"5px solid transparent", borderTop:"9px solid white" }}/>
        </div>
      )}

      {/* Body */}
      <div style={{ animation: trick ? `${trick} 0.9s cubic-bezier(0.34,1.56,0.64,1) both` : baseAnim, transformOrigin:"center bottom" }}>
        <AnimalBody animal={animal} pct={animalPct} color={color} size={size} outfit={outfit}/>
      </div>

      {/* Night Z's */}
      {isNight && (
        <div style={{ position:"absolute", top:-10, right:-20, pointerEvents:"none" }}>
          {[0,1,2].map(i => (
            <div key={i} style={{
              fontSize: 10 + i*4,
              fontWeight:900,
              color:"#9CA8D6",
              position:"absolute",
              right: i * 10,
              top: -i * 14,
              animation:`nightZ 2.4s ease-in-out ${i*0.7}s infinite`,
              fontFamily:"'Nunito',sans-serif",
            }}>Z</div>
          ))}
        </div>
      )}

      {/* Trick "!" exclamation — shows on tap */}
      {trick && (
        <div style={{ position:"absolute", top:-16, right:-8, fontSize:22, fontWeight:900, color:"#FFD700", pointerEvents:"none", animation:"popIn 0.3s ease both" }}>!</div>
      )}
    </div>
  );
}

// ── Island: full scene SVG ────────────────────────────────────────────────────
// `mini` = render at preview scale with no static decoration (no clouds, no
// sand pattern detail) for the Today screen thumbnail.
function IslandScene({ user, aColor, level, mini=false, onTapTier, fillScreen=false }) {
  const tod = useTimeOfDay();
  const palette = TOD_THEMES[tod];
  const isOn = id => islandTierUnlocked(level, id);
  const tap  = (id) => {
    if (!onTapTier) return;
    return (e) => onTapTier(id, e);
  };

  const friendColors = ["#FFB7B2", "#B5DEFF"];
  const bothFriends  = isOn("friend1") && isOn("friend2");

  // Star positions — fixed, not random per render.
  const STARS = [
    [120,60],[260,90],[380,40],[520,70],[640,50],[780,90],[920,55],
    [1060,80],[1200,40],[1320,70],[80,140],[450,160],[820,180],[1140,150],
  ];

  // TOD-based animal position — smooth CSS transition handles the glide.
  const animalPos = ANIMAL_TOD_POSITIONS[tod] || ANIMAL_TOD_POSITIONS.day;

  return (
    <svg viewBox="0 0 1400 600" preserveAspectRatio="xMidYMid meet"
      style={{ display:"block", width:"100%", height:fillScreen?"100%":"auto", transition:"filter 1s ease" }}>
      <defs>
        <linearGradient id="islandSky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"   stopColor={palette.sky[0]}/>
          <stop offset="60%"  stopColor={palette.sky[1]}/>
          <stop offset="100%" stopColor={palette.sky[2]}/>
        </linearGradient>
        <linearGradient id="islandSea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"   stopColor={palette.sea[0]}/>
          <stop offset="100%" stopColor={palette.sea[1]}/>
        </linearGradient>
        <radialGradient id="islandSand" cx="50%" cy="40%" r="60%">
          <stop offset="0%"  stopColor="#F5DDA8"/>
          <stop offset="100%" stopColor="#D4B97A"/>
        </radialGradient>
        <radialGradient id="islandSunGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor={palette.sunGlow} stopOpacity="0.5"/>
          <stop offset="100%" stopColor={palette.sunGlow} stopOpacity="0"/>
        </radialGradient>
      </defs>

      {/* Sky */}
      <rect x="0" y="0" width="1400" height="430" fill="url(#islandSky)"/>

      {/* Stars (night only) */}
      {palette.stars && STARS.map(([sx,sy], i) => (
        <circle key={i} cx={sx} cy={sy} r={i%3===0?1.6:1} fill="white" opacity={0.7+0.3*Math.sin(i)}
          style={{ animation:`islandStarTwinkle ${2+i*0.2}s ease-in-out infinite`, animationDelay:`${i*0.15}s`, transformOrigin:`${sx}px ${sy}px` }}/>
      ))}

      {/* Moon at night, sun otherwise */}
      <circle cx="1100" cy={palette.sunY} r="65" fill="url(#islandSunGlow)"/>
      <circle cx="1100" cy={palette.sunY} r="50" fill={palette.sunFill}/>
      {tod === "night" && (
        <>
          {/* Moon crater detail */}
          <circle cx="1090" cy={palette.sunY - 8} r="6" fill="#C9CCE0" opacity="0.5"/>
          <circle cx="1115" cy={palette.sunY + 6} r="4" fill="#C9CCE0" opacity="0.5"/>
        </>
      )}

      {/* Clouds (slow parallax-style drift; full scene only, day/dawn/dusk only) */}
      {!mini && tod !== "night" && (
        <g opacity={tod === "dusk" ? 0.55 : 0.85} style={{ animation:"islandCloudsDrift 80s linear infinite" }}>
          <ellipse cx="180" cy="100"  rx="40" ry="14" fill="white"/>
          <ellipse cx="200" cy="95"   rx="32" ry="12" fill="white"/>
          <ellipse cx="500" cy="140"  rx="46" ry="16" fill="white"/>
          <ellipse cx="525" cy="135"  rx="34" ry="13" fill="white"/>
          <ellipse cx="900" cy="80"   rx="38" ry="13" fill="white"/>
          <ellipse cx="920" cy="78"   rx="28" ry="10" fill="white"/>
        </g>
      )}

      {/* Birds (flock of 3 V-shapes, drift across sky on staggered loops) */}
      {!mini && (
        <g opacity={tod === "night" ? 0 : 0.7} style={{ transition:"opacity 1s" }}>
          <g style={{ animation:"islandBirdsDrift 28s linear infinite" }}>
            <path d="M 0 0 L 5 -3 L 10 0 M 10 0 L 15 -3 L 20 0" stroke="#333" strokeWidth="1.5" fill="none" strokeLinecap="round" transform="translate(-100, 180)"/>
          </g>
          <g style={{ animation:"islandBirdsDrift 36s linear infinite 8s" }}>
            <path d="M 0 0 L 4 -2 L 8 0 M 8 0 L 12 -2 L 16 0" stroke="#333" strokeWidth="1.2" fill="none" strokeLinecap="round" transform="translate(-100, 220)"/>
          </g>
          <g style={{ animation:"islandBirdsDrift 32s linear infinite 16s" }}>
            <path d="M 0 0 L 5 -3 L 10 0 M 10 0 L 15 -3 L 20 0" stroke="#333" strokeWidth="1.4" fill="none" strokeLinecap="round" transform="translate(-100, 150)"/>
          </g>
        </g>
      )}

      {/* Mountain (back layer — must render before ground/sea) */}
      {isOn("mountain") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("mountain") : undefined} data-tier="mountain">
          <IslandMountain x={ISLAND_POSITIONS.mountain.x} y={ISLAND_POSITIONS.mountain.y}/>
        </g>
      )}

      {/* Sea */}
      <rect x="0" y="430" width="1400" height="170" fill="url(#islandSea)"/>

      {/* Sea sparkles (day/dawn only) */}
      {!mini && (tod === "day" || tod === "dawn") && [120, 380, 1180, 1320].map((sx, i) => (
        <circle key={i} cx={sx} cy={460 + (i%3)*8} r="2.5" fill="white" opacity="0.7"
          style={{ animation:`islandSparkle ${1.6+i*0.3}s ease-in-out infinite`, animationDelay:`${i*0.2}s`, transformOrigin:`${sx}px ${460+(i%3)*8}px` }}/>
      ))}

      {/* Moon reflection at night */}
      {tod === "night" && (
        <ellipse cx="1080" cy="465" rx="40" ry="6" fill="#E6E6FF" opacity="0.35"
          style={{ animation:"islandSparkle 3s ease-in-out infinite", transformOrigin:"1080px 465px" }}/>
      )}

      {/* Main island sand + grass */}
      <ellipse cx="660" cy="500" rx="540" ry="70" fill="url(#islandSand)"/>
      <ellipse cx="660" cy="490" rx="510" ry="55" fill="#7AD37A"/>
      <ellipse cx="660" cy="488" rx="490" ry="48" fill="#8DDB8D"/>

      {/* Boat sits on sea, in front of main island */}
      {isOn("boat") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("boat") : undefined} data-tier="boat">
          <IslandBoat x={ISLAND_POSITIONS.boat.x} y={ISLAND_POSITIONS.boat.y}/>
        </g>
      )}

      {/* Hut */}
      {isOn("hut") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("hut") : undefined} data-tier="hut">
          <IslandHut x={ISLAND_POSITIONS.hut.x} y={ISLAND_POSITIONS.hut.y}/>
        </g>
      )}

      {/* First tree */}
      {isOn("tree1") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("tree1") : undefined} data-tier="tree1">
          <IslandTree x={ISLAND_POSITIONS.tree1.x} y={ISLAND_POSITIONS.tree1.y}/>
        </g>
      )}

      {/* Pond */}
      {isOn("pond") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("pond") : undefined} data-tier="pond">
          <IslandPond x={ISLAND_POSITIONS.pond.x} y={ISLAND_POSITIONS.pond.y}/>
        </g>
      )}

      {/* Bridge over pond */}
      {isOn("bridge") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("bridge") : undefined} data-tier="bridge">
          <IslandBridge x={ISLAND_POSITIONS.bridge.x} y={ISLAND_POSITIONS.bridge.y}/>
        </g>
      )}

      {/* Friend 1 */}
      {isOn("friend1") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("friend1") : undefined} data-tier="friend1">
          <IslandFriend x={ISLAND_POSITIONS.friend1.x} y={ISLAND_POSITIONS.friend1.y}
            color={friendColors[0]} faceRight={bothFriends}/>
        </g>
      )}

      {/* Friend 2 */}
      {isOn("friend2") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("friend2") : undefined} data-tier="friend2">
          <IslandFriend x={ISLAND_POSITIONS.friend2.x} y={ISLAND_POSITIONS.friend2.y}
            color={friendColors[1]} faceRight={false}/>
        </g>
      )}

      {/* Ball arcs between friends when both are present */}
      {bothFriends && (
        <circle r="6" fill="#E55A4F"
          cx={ISLAND_POSITIONS.friend1.x + 22}
          cy={ISLAND_POSITIONS.friend1.y}
          style={{ animation:"friendBallArc 2.2s ease-in-out infinite",
            transformOrigin:`${ISLAND_POSITIONS.friend1.x + 22}px ${ISLAND_POSITIONS.friend1.y}px` }}>
        </circle>
      )}

      {/* Lighthouse */}
      {isOn("lighthouse") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("lighthouse") : undefined} data-tier="lighthouse">
          <IslandLighthouse x={ISLAND_POSITIONS.lighthouse.x} y={ISLAND_POSITIONS.lighthouse.y} beamStrength={palette.beam}/>
        </g>
      )}

      {/* Jungle (second island) */}
      {isOn("jungle") && (
        <g className={onTapTier ? "island-tappable" : ""} onClick={onTapTier ? tap("jungle") : undefined} data-tier="jungle">
          <IslandJungle x={ISLAND_POSITIONS.jungle.x} y={ISLAND_POSITIONS.jungle.y}/>
        </g>
      )}

      {/* Animal — LiveAnimal handles TOD position, tricks, thought bubbles, night Z's.
          Using a <g> with CSS transform so the 2.5s position glide actually works
          (SVG attribute transitions on x/y are not CSS-animatable). The body is
          120px wide × 222px tall (120 × BODY_RATIO); foreignObject anchored at -60
          centres it; y=0 places the head at the group origin. */}
      <g style={{ transform:`translate(${animalPos.x}px, ${animalPos.y}px)`, transition:"transform 2.5s ease-in-out" }}>
        <foreignObject x="-60" y="0" width="120" height="222" style={{ overflow:"visible" }}>
          <div style={{ width:120, height:222, display:"flex", alignItems:"flex-start", justifyContent:"center" }}>
            <LiveAnimal
              animal={user.animal||"cat"}
              color={aColor}
              outfit={user.outfitId||"none"}
              pct={1}
              size={120}
              tod={tod}
              mealState="partial"
              context="island"
            />
          </div>
        </foreignObject>
      </g>

      {/* Night-time darkening overlay over the land — reads more atmospheric */}
      {tod === "night" && (
        <rect x="0" y="0" width="1400" height="600" fill="#0E1B3A" opacity="0.18" pointerEvents="none"/>
      )}
    </svg>
  );
}

// ── Island: unlock celebration banner ────────────────────────────────────────
// Fires when a kid lands on the island screen and one or more tiers have
// unlocked since they last looked. The set of seen tier ids is stored in
// localStorage (`tdf_island_seen` keyed by user id) so this is purely a
// client-side delight moment — no backend involvement.
function IslandUnlockBanner({ tiers, theme, onDismiss }) {
  // Auto-dismiss after a beat so it doesn't block the scene forever.
  useEffect(() => {
    const id = setTimeout(onDismiss, 6000);
    return () => clearTimeout(id);
  }, [onDismiss]);

  const headline = tiers.length === 1
    ? `You unlocked ${tiers[0].label}!`
    : `${tiers.length} new unlocks!`;

  return (
    <div onClick={onDismiss}
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:120, display:"flex", alignItems:"center", justifyContent:"center", padding:"24px", animation:"fadeUp 0.4s ease" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:`linear-gradient(135deg, ${theme.accent}, ${theme.dark})`, color:"white", borderRadius:24, padding:"24px 28px", maxWidth:360, width:"100%", textAlign:"center", boxShadow:`0 12px 40px ${theme.accent}aa`, position:"relative", overflow:"hidden", animation:"islandUnlockBurst 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)" }}>
        {/* Sparkle particles around the card */}
        {[15, 35, 55, 75, 88, 12, 30, 70].map((p, i) => (
          <div key={i} style={{
            position:"absolute",
            top: `${(i*23)%80 + 5}%`,
            left: `${p}%`,
            width:8, height:8,
            background:"white",
            borderRadius:"50%",
            animation:`islandUnlockSparkle 1.4s ease-out infinite ${i*0.15}s`,
            pointerEvents:"none",
          }}/>
        ))}
        <div style={{ fontSize:48, marginBottom:8, animation:"float 2s ease-in-out infinite" }}>🎉</div>
        <div style={{ fontSize:11, fontWeight:900, letterSpacing:2, opacity:0.85 }}>NEW UNLOCK</div>
        <div style={{ fontSize:24, fontWeight:900, marginTop:6 }}>{headline}</div>
        <div style={{ fontSize:13, fontWeight:700, opacity:0.92, marginTop:8, lineHeight:1.4 }}>
          {tiers.length === 1 ? tiers[0].hint : tiers.map(t => t.label).join(" · ")}
        </div>
        <button onClick={onDismiss}
          style={{ marginTop:18, background:"white", color:theme.accent, border:"none", borderRadius:14, padding:"12px 22px", fontSize:14, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
          Cool!
        </button>
      </div>
    </div>
  );
}

// ── Island: tap-info popover ─────────────────────────────────────────────────
function IslandTierPopover({ tier, level, theme, onClose }) {
  const unlocked = level >= tier.level;
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:90, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", animation:"slideUp 0.25s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 24px 18px" }}>
          <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:theme.accent }}>
            {unlocked ? `UNLOCKED AT LEVEL ${tier.level}` : `LOCKED · LEVEL ${tier.level}`}
          </div>
          <div style={{ fontSize:22, fontWeight:900, color:"#333", marginTop:6 }}>{tier.label}</div>
          <div style={{ fontSize:14, color:"#666", fontWeight:700, marginTop:6, lineHeight:1.4 }}>{tier.hint}</div>
          <button onClick={onClose}
            style={{ width:"100%", marginTop:18, background:theme.accent, color:"white", border:"none", borderRadius:14, padding:"12px", fontSize:14, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:`0 4px 14px ${theme.accent}55` }}>
            {unlocked ? "Cool!" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Eating reaction overlay ──────────────────────────────────────────────────
// Fires when a kid logs a main meal. Full-screen takeover with the food, the
// animal, and a rating-specific reaction sequence (~1.7s). Dismisses on tap or
// auto. Snacks and edits skip this and use the toast instead.
function EatingReactionOverlay({ reaction, onDismiss }) {
  const { food, rating, wasNew, xp, animal, aColor, outfitId } = reaction;

  useEffect(() => {
    const id = setTimeout(onDismiss, 3500);
    return () => clearTimeout(id);
  }, [onDismiss]);

  const variant = {
    all:    { name: "MMMM!", color: "#FFD700" },
    most:   { name: "Yum!",  color: "#7BC97B" },
    barely: { name: "Bleh!", color: "#C9A4E5" },
  }[rating] || { name: "Yum!", color: "#7BC97B" };

  const animClass = rating === "all"    ? "reactJump"
                  : rating === "most"   ? "reactNod"
                  : rating === "barely" ? "reactWince"
                  : "reactNod";

  return (
    <div onClick={onDismiss}
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", zIndex:300, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", animation:"fadeUp 0.3s ease", overflow:"hidden", touchAction:"none" }}>

      {/* Food — falls into the animal's mouth on "all", just pops in for others */}
      <div style={{
        marginBottom:-30, position:"relative", zIndex:2,
        animation: rating === "all"
          ? "foodFalls 2.0s cubic-bezier(0.5,0,0.6,1) 0.7s forwards"
          : "popIn 0.4s cubic-bezier(0.34,1.56,0.64,1) 0.1s both",
      }}>
        {food.heroPhotoId
          ? <img src={photoUrl(food.heroPhotoId)} alt="" style={{ width:90, height:90, borderRadius:22, objectFit:"cover", boxShadow:"0 6px 24px rgba(0,0,0,0.5)" }}/>
          : <div style={{ fontSize:80, filter:"drop-shadow(0 6px 14px rgba(0,0,0,0.4))" }}>{food.emoji}</div>}
      </div>

      {/* Animal with rating-specific reaction */}
      <div style={{ position:"relative", zIndex:1, animation:`${animClass} 2.6s cubic-bezier(0.4,0,0.2,1) 0.3s both`, transformOrigin:"center bottom" }}>
        <AnimalBody animal={animal} pct={rating==="barely"?0.15:1} color={aColor} size={200} outfit={outfitId||"none"}/>

        {/* "All gone" — hearts and sparkles burst outward in a ring */}
        {rating === "all" && [0,60,120,180,240,300].map(angle => (
          <div key={angle} style={{ position:"absolute", top:"50%", left:"50%", transform:`rotate(${angle}deg)`, transformOrigin:"0 0" }}>
            <div style={{ fontSize:36, animation:"heartFly 1.8s ease-out 1.8s both" }}>{angle%120 === 0 ? "✨" : "💖"}</div>
          </div>
        ))}

        {/* "Most" — thumbs up floats up next to head */}
        {rating === "most" && (
          <div style={{ position:"absolute", top:-10, right:-30, fontSize:60, animation:"thumbUpFloat 2.2s cubic-bezier(0.34,1.56,0.64,1) 1.2s both" }}>👍</div>
        )}

        {/* "Barely" — yuck cloud and droplet */}
        {rating === "barely" && (
          <>
            <div style={{ position:"absolute", top:0, right:-40, fontSize:52, animation:"yuckPuff 1.6s ease-out 1.0s forwards" }}>💨</div>
            <div style={{ position:"absolute", bottom:30, left:-20, fontSize:24, animation:"yuckPuff 1.6s ease-out 1.4s forwards" }}>💧</div>
          </>
        )}

        {/* New-food ring around the animal */}
        {wasNew && (
          <div style={{ position:"absolute", top:-25, left:-25, right:-25, bottom:-25, border:"5px dashed #FFD700", borderRadius:"50%", animation:"newRingPulse 1.6s ease-in-out infinite", pointerEvents:"none" }}/>
        )}
      </div>

      {/* Big reaction text */}
      <div style={{ marginTop:24, textAlign:"center", fontFamily:"'Nunito',sans-serif", animation:"popText 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.2s both" }}>
        <div style={{ fontSize:54, fontWeight:900, color:variant.color, textShadow:"0 4px 24px rgba(0,0,0,0.6)", letterSpacing:1 }}>{variant.name}</div>
        <div style={{ marginTop:6, color:"white", fontSize:18, fontWeight:800 }}>
          {wasNew ? "✨ NEW FOOD! " : ""}+{xp} XP
        </div>
      </div>
    </div>
  );
}

// ── Level-up cinematic ───────────────────────────────────────────────────────
// Full-screen takeover when the kid's level rises. Shows the new level, the
// animal in victory pose with sparkles, confetti rain, and a teaser for the
// next island unlock. Dismisses on tap or auto after ~5s.
function LevelUpCinematic({ data, onDismiss }) {
  const { newLevel, animal, aColor, outfitId, nextTier, nextOutfit, theme } = data;

  useEffect(() => {
    const id = setTimeout(onDismiss, 5000);
    return () => clearTimeout(id);
  }, [onDismiss]);

  // Confetti — precomputed so they don't reshuffle on re-render
  const confetti = [...Array(36)].map((_, i) => {
    const colors = ["#FFD700","#FF6B9D","#7BC97B","#5DADE2","#FFA500","#9B59B6","#FF4757","#42E2B8"];
    return {
      key: i,
      left: (i * 11 + (i*i)%19) % 100,
      width: 6 + (i%4)*3,
      height: 12 + (i%5)*3,
      color: colors[i % colors.length],
      duration: 2.2 + (i%5)*0.4,
      delay: (i % 8) * 0.2,
      shape: i % 3,
    };
  });

  return (
    <div onClick={onDismiss}
      style={{ position:"fixed", inset:0, zIndex:310, background:`radial-gradient(circle at 50% 30%, ${theme.accent} 0%, ${theme.dark||"#222"} 100%)`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", overflow:"hidden", animation:"fadeUp 0.5s ease", touchAction:"none" }}>

      {/* Confetti rain */}
      {confetti.map(c => (
        <div key={c.key} style={{
          position:"absolute",
          top:-20,
          left:`${c.left}%`,
          width:c.width, height:c.height,
          background:c.color,
          borderRadius: c.shape === 0 ? "50%" : c.shape === 1 ? 2 : 0,
          animation:`confettiFall ${c.duration}s linear ${c.delay}s infinite`,
          pointerEvents:"none",
        }}/>
      ))}

      {/* Top label */}
      <div style={{ color:"white", fontSize:14, fontWeight:900, letterSpacing:4, opacity:0.9, fontFamily:"'Nunito',sans-serif", animation:"popText 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.3s both", zIndex:1 }}>
        ★ LEVEL UP ★
      </div>

      {/* Big level number */}
      <div style={{ color:"white", fontSize:140, fontWeight:900, lineHeight:1, marginTop:8, fontFamily:"'Nunito',sans-serif", textShadow:`0 8px 40px rgba(0,0,0,0.5), 0 0 60px ${theme.accent}aa`, animation:"levelBigBounce 0.9s cubic-bezier(0.34,1.56,0.64,1) 0.5s both", zIndex:1 }}>
        {newLevel}
      </div>

      {/* Animal with sparkle ring */}
      <div style={{ marginTop:10, animation:"levelAnimalPop 0.8s cubic-bezier(0.34,1.56,0.64,1) 0.7s both", position:"relative", zIndex:1 }}>
        <AnimalBody animal={animal} pct={1} color={aColor} size={180} outfit={outfitId||"none"}/>
        {[15, 75, 165, 255, 345].map((angle, i) => (
          <div key={i} style={{
            position:"absolute", top:"50%", left:"50%",
            transform: `rotate(${angle}deg) translateX(120px)`,
            transformOrigin: "0 0",
            pointerEvents: "none",
          }}>
            <div style={{ fontSize:28, animation:`twinkle 1.6s ease-in-out ${0.9 + i*0.15}s infinite` }}>✨</div>
          </div>
        ))}
      </div>

      {/* Subtitle / next unlock */}
      <div style={{ marginTop:24, textAlign:"center", color:"white", fontFamily:"'Nunito',sans-serif", animation:"popText 0.5s ease 1.3s both", padding:"0 24px", zIndex:1 }}>
        <div style={{ fontSize:22, fontWeight:900 }}>You're amazing! 🎉</div>
        {(nextTier || nextOutfit) && (
          <div style={{ fontSize:13, fontWeight:700, opacity:0.85, marginTop:8, lineHeight:1.8 }}>
            {nextTier && <div>🏝️ Next island unlock: <strong>{nextTier.label}</strong> at level {nextTier.level}</div>}
            {nextOutfit && <div>👗 Next outfit: <strong>{nextOutfit.label}</strong> at level {nextOutfit.level}</div>}
          </div>
        )}
      </div>

      {/* Tap hint */}
      <div style={{ position:"absolute", bottom:30, color:"white", fontSize:11, fontWeight:800, opacity:0.55, letterSpacing:2, fontFamily:"'Nunito',sans-serif", animation:"popText 0.5s ease 2.0s both", zIndex:1 }}>TAP TO CONTINUE</div>
    </div>
  );
}

// ── Island: locked-state cover (L1–L2) ───────────────────────────────────────
function IslandLockedCover({ user, theme, level, totalXp, onBack }) {
  const next = islandNextTier(level) || ISLAND_TIERS[0];
  const xpToFirstUnlock = xpForLevel(2) - totalXp;
  return (
    <div style={{ minHeight:"100vh", background:`linear-gradient(180deg, ${theme.dark} 0%, ${theme.accent} 100%)`, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", color:"white", display:"flex", flexDirection:"column" }}>
      <div style={{ padding:"18px 18px 0" }}>
        <GhostButton onClick={onBack}>← Back</GhostButton>
      </div>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 28px", textAlign:"center" }}>
        <div style={{ fontSize:80, marginBottom:14, animation:"float 3.5s ease-in-out infinite" }}>🏝️</div>
        <div style={{ fontSize:11, fontWeight:900, letterSpacing:2, opacity:0.7 }}>YOUR ISLAND AWAITS</div>
        <div style={{ fontSize:26, fontWeight:900, marginTop:8 }}>{user.name}'s Island</div>
        <div style={{ fontSize:14, fontWeight:700, opacity:0.85, marginTop:14, lineHeight:1.5 }}>
          Reach <strong>Level 2</strong> to plant your first tree and start your island adventure.
        </div>
        <div style={{ background:"rgba(255,255,255,0.15)", borderRadius:18, padding:"14px 18px", marginTop:24, width:"100%", maxWidth:280 }}>
          <div style={{ fontSize:11, fontWeight:800, opacity:0.7, letterSpacing:1 }}>LEVEL {level} · NEXT: {next.label.toUpperCase()}</div>
          <div style={{ fontSize:13, fontWeight:700, marginTop:10, opacity:0.95 }}>
            {xpToFirstUnlock > 0 ? `${xpToFirstUnlock} XP to unlock` : "Almost there!"}
          </div>
        </div>
        <div style={{ marginTop:32, fontSize:12, fontWeight:700, opacity:0.7 }}>
          🌳 🐠 🏠 🌉 🚤 ⛰️ 🗼
        </div>
      </div>
    </div>
  );
}

// ── Island: full-screen scrollable scene ─────────────────────────────────────
function IslandScreen({ user, aColor, theme, level, totalXp, onBack }) {
  const [popover, setPopover]       = useState(null);
  const [celebrate, setCelebrate]   = useState(null); // null | array of tier objects
  const [fullscreen, setFullscreen] = useState(false);
  // Track viewport so we can recompute the rotated stage on orientation change.
  const [viewport, setViewport]     = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.innerHeight : 0,
  }));
  const wrapRef = useRef(null);

  // Tap-to-wobble: add a class for ~500ms, then remove. Pure CSS animation
  // does the actual wobble (defined in CSS block as islandTap).
  const handleTapTier = (tierId, e) => {
    const tier = ISLAND_TIERS.find(t => t.id === tierId);
    if (!tier) return;
    const node = e.currentTarget;
    node.classList.add("island-wobbling");
    setTimeout(() => node.classList.remove("island-wobbling"), 520);
    setPopover(tier);
  };

  // Auto-scroll to centre on first render so the kid sees the animal.
  useEffect(() => {
    const w = wrapRef.current;
    if (!w) return;
    const target = (660 / 1400) * w.scrollWidth - w.clientWidth / 2;
    w.scrollLeft = Math.max(0, target);
  }, [user?.id]);

  // Unlock celebration: compare currently-unlocked tier ids against the set
  // we've previously shown to this kid. Any new ones trigger the banner, then
  // get persisted to localStorage so we don't re-celebrate next visit.
  useEffect(() => {
    if (level < 2) return; // never celebrate from the locked screen
    const key = `tdf_island_seen_${user.id}`;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
    const seenSet = new Set(seen);
    const currentlyUnlocked = ISLAND_TIERS.filter(t => level >= t.level);
    const newlyUnlocked = currentlyUnlocked.filter(t => !seenSet.has(t.id));
    if (newlyUnlocked.length > 0) {
      // Wait a beat so the scene renders first, then surface the banner.
      const id = setTimeout(() => setCelebrate(newlyUnlocked), 450);
      // Mark them as seen now (not after dismiss) so reloads in the middle of
      // the celebration don't fire it twice.
      try {
        localStorage.setItem(key, JSON.stringify(currentlyUnlocked.map(t => t.id)));
      } catch {}
      return () => clearTimeout(id);
    }
  }, [user?.id, level]);

  // ── Fullscreen / landscape helpers ─────────────────────────────────────────
  const enterFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch(e) { /* not supported or denied — continue anyway */ }
    // Try the orientation API. If it works the viewport will report landscape
    // dimensions naturally and we won't need the CSS rotation fallback.
    try {
      await screen.orientation.lock("landscape");
    } catch(e) { /* lock unavailable — CSS rotation will handle it */ }
    setFullscreen(true);
  };

  const exitFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch(e) { /* ignore */ }
    try { screen.orientation.unlock(); } catch(e) { /* ignore */ }
    setFullscreen(false);
  };

  // Sync state if the user exits fullscreen via the Android back gesture, and
  // keep viewport dims fresh for the rotated stage calculation.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        try { screen.orientation.unlock(); } catch(e) {}
        setFullscreen(false);
      }
    };
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // ── Fullscreen landscape render ─────────────────────────────────────────────
  // Strategy: if the viewport is currently portrait (height > width), the
  // orientation API failed — so we rotate the content 90deg via CSS to fake
  // landscape. The stage's logical width/height are SWAPPED relative to the
  // viewport so the rotated rectangle fills the screen exactly.
  if (fullscreen) {
    const isPortrait = viewport.h > viewport.w;
    const stageW = isPortrait ? viewport.h : viewport.w;
    const stageH = isPortrait ? viewport.w : viewport.h;
    const stageTransform = isPortrait
      ? "translate(-50%, -50%) rotate(90deg)"
      : "translate(-50%, -50%)";

    return (
      <div style={{ position:"fixed", inset:0, background:"#000", zIndex:200, overflow:"hidden" }}>
        <div style={{
          position:"absolute",
          top:"50%", left:"50%",
          width: stageW, height: stageH,
          transform: stageTransform,
          transformOrigin:"center center",
          display:"flex", alignItems:"center", justifyContent:"center"
        }}>
          <IslandScene user={user} aColor={aColor} level={level} onTapTier={handleTapTier} fillScreen={true}/>

          {/* Exit button lives INSIDE the rotated stage so it visually appears
              top-right of the landscape view regardless of phone orientation. */}
          <button onClick={exitFullscreen}
            style={{ position:"absolute", top:14, right:14, background:"rgba(0,0,0,0.55)", border:"2px solid rgba(255,255,255,0.25)", backdropFilter:"blur(10px)", borderRadius:14, width:44, height:44, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, cursor:"pointer", color:"white", zIndex:201 }}>
            ✕
          </button>
        </div>

        {/* Popovers stay OUTSIDE the rotated stage — position:fixed renders them
            in screen coords so the user can read them without tilting their head
            while holding the phone in portrait. */}
        {popover && <IslandTierPopover tier={popover} level={level} theme={theme} onClose={()=>setPopover(null)}/>}
        {celebrate && <IslandUnlockBanner tiers={celebrate} theme={theme} onDismiss={()=>setCelebrate(null)}/>}
      </div>
    );
  }

  // ── Normal portrait render ──────────────────────────────────────────────────
  if (level < 2) {
    return <IslandLockedCover user={user} theme={theme} level={level} totalXp={totalXp} onBack={onBack}/>;
  }

  const next = islandNextTier(level);
  const unlockedCount = islandUnlockedCount(level);

  return (
    <div style={{ minHeight:"100vh", background:theme.light, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", paddingBottom:30 }}>
      {/* Header */}
      <div style={{ background:theme.accent, borderRadius:"0 0 36px 36px", padding:"18px 18px 22px", color:"white", boxShadow:`0 8px 30px ${theme.accent}55` }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <GhostButton onClick={onBack}>← Back</GhostButton>
          <div style={{ textAlign:"center", flex:1 }}>
            <div style={{ fontWeight:900, fontSize:20 }}>🏝️ {user.name}'s Island</div>
            <div style={{ fontSize:11, opacity:0.85, fontWeight:700, marginTop:2 }}>
              Level {level} · {unlockedCount}/{ISLAND_TIERS.length} unlocked
            </div>
          </div>
          <div style={{ width:60 }}/>
        </div>

        {/* Tier dot strip */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:14, gap:2 }}>
          {ISLAND_TIERS.map((t, i) => {
            const on = level >= t.level;
            const nextOn = i < ISLAND_TIERS.length - 1 ? level >= ISLAND_TIERS[i+1].level : false;
            return (
              <div key={t.id} style={{ display:"contents" }}>
                <div style={{ width:on?12:8, height:on?12:8, borderRadius:"50%", background:on?"white":"rgba(255,255,255,0.25)", flexShrink:0, transition:"all 0.3s" }}/>
                {i < ISLAND_TIERS.length - 1 && (
                  <div style={{ flex:1, height:2, background: nextOn ? "white" : "rgba(255,255,255,0.18)" }}/>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scrollable scene — fullscreen button overlaid top-right */}
      <div style={{ position:"relative", margin:"14px 0" }}>
        <div ref={wrapRef} style={{ overflowX:"auto", overflowY:"hidden", WebkitOverflowScrolling:"touch", scrollbarWidth:"none" }}>
          <div style={{ width:"180%", minWidth:780 }}>
            <IslandScene user={user} aColor={aColor} level={level} onTapTier={handleTapTier}/>
          </div>
        </div>
        {/* Fullscreen expand button */}
        <button onClick={enterFullscreen}
          style={{ position:"absolute", top:10, right:10, background:"rgba(0,0,0,0.35)", border:"2px solid rgba(255,255,255,0.3)", backdropFilter:"blur(8px)", borderRadius:12, width:38, height:38, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, cursor:"pointer", color:"white", zIndex:10 }}>
          ⛶
        </button>
      </div>

      <div style={{ textAlign:"center", padding:"0 20px 4px", fontSize:11, fontWeight:800, color:"#aaa", letterSpacing:1 }}>
        ← SWIPE TO EXPLORE →
      </div>

      {/* Next unlock preview */}
      {next && (
        <div style={{ margin:"16px 16px 0", background:"white", borderRadius:18, padding:"14px 16px", boxShadow:"0 4px 14px rgba(0,0,0,0.05)", display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:48, height:48, borderRadius:14, background:theme.light, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🔒</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, fontWeight:900, letterSpacing:1.5, color:theme.accent }}>NEXT UNLOCK · LEVEL {next.level}</div>
            <div style={{ fontSize:15, fontWeight:900, color:"#333", marginTop:2 }}>{next.label}</div>
            <div style={{ fontSize:12, color:"#999", fontWeight:700, marginTop:1 }}>
              {(xpForLevel(next.level) - totalXp)} XP to go
            </div>
          </div>
        </div>
      )}

      {/* Tier list */}
      <div style={{ padding:"16px 16px 20px" }}>
        <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, color:"#bbb", margin:"0 6px 10px" }}>UNLOCKS</div>
        {ISLAND_TIERS.map(t => {
          const on = level >= t.level;
          return (
            <div key={t.id} onClick={()=>setPopover(t)}
              style={{ background:on?"white":"#fafafa", borderRadius:14, padding:"10px 12px", marginBottom:6, display:"flex", alignItems:"center", gap:12, cursor:"pointer", border:on?"2px solid transparent":`2px dashed ${theme.accent}33`, opacity:on?1:0.7 }}>
              <div style={{ width:36, height:36, borderRadius:10, background:on?theme.light:"#f0f0f0", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>
                {on ? "✓" : "🔒"}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:10, fontWeight:800, letterSpacing:1, color:on?theme.accent:"#bbb" }}>LEVEL {t.level}</div>
                <div style={{ fontSize:14, fontWeight:900, color:on?"#333":"#999" }}>{t.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      {popover && <IslandTierPopover tier={popover} level={level} theme={theme} onClose={()=>setPopover(null)}/>}
      {celebrate && <IslandUnlockBanner tiers={celebrate} theme={theme} onDismiss={()=>setCelebrate(null)}/>}
    </div>
  );
}

// ── Island: miniature CTA button on Today screen ─────────────────────────────
// Live preview of the kid's actual island, shown as a wide rounded card below
// the snacks. When locked (L<3), shows a teaser with a padlocked island.
function IslandThumbnailButton({ user, aColor, theme, level, totalXp, onTap }) {
  const locked = level < 2;
  const next = islandNextTier(level);
  const unlockedCount = islandUnlockedCount(level);

  return (
    <button onClick={onTap}
      style={{ width:"100%", border:"none", padding:0, background:"transparent", cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"block" }}>
      <div style={{ background:"white", borderRadius:22, overflow:"hidden", boxShadow:"0 6px 22px rgba(0,0,0,0.08)", border:`2px solid ${theme.accent}22` }}>

        {/* Live miniature scene */}
        <div style={{ position:"relative", height:140, overflow:"hidden", background:"linear-gradient(180deg,#A8DDF0 0%,#D4F0FB 60%,#FCE9C5 100%)" }}>
          <div style={{ position:"absolute", inset:0, transform:"scale(1)", filter:locked?"saturate(0.4) brightness(0.85)":"none" }}>
            <IslandScene user={user} aColor={aColor} level={locked ? 0 : level} mini={true}/>
          </div>
          {locked && (
            <div style={{ position:"absolute", inset:0, background:"rgba(20,30,50,0.32)", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ background:"rgba(0,0,0,0.6)", color:"white", borderRadius:14, padding:"6px 14px", fontSize:12, fontWeight:900, letterSpacing:1, display:"flex", alignItems:"center", gap:6 }}>
                🔒 REACH LEVEL 2
              </div>
            </div>
          )}
        </div>

        {/* Caption strip */}
        <div style={{ padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <div style={{ minWidth:0, textAlign:"left" }}>
            <div style={{ fontSize:11, fontWeight:900, letterSpacing:1.5, color:theme.accent }}>🏝️ MY ISLAND</div>
            <div style={{ fontSize:14, fontWeight:900, color:"#333", marginTop:2 }}>
              {locked
                ? `${xpForLevel(2) - totalXp} XP to unlock`
                : `${unlockedCount}/${ISLAND_TIERS.length} unlocked${next ? ` · next: ${next.label}` : " · all built!"}`}
            </div>
          </div>
          <div style={{ background:theme.accent, color:"white", borderRadius:14, padding:"8px 14px", fontSize:13, fontWeight:900, whiteSpace:"nowrap", boxShadow:`0 3px 10px ${theme.accent}55` }}>
            {locked ? "Preview" : "Visit ›"}
          </div>
        </div>
      </div>
    </button>
  );
}

// ── End island module ─────────────────────────────────────────────────────────


function MoveTargetPicker({ user, plans, fromCtx, theme, onPick, onClose }) {
  const todayIso = today();
  const baseMonday = mondayOf(todayIso);
  const allDays = [...daysOfWeek(baseMonday), ...daysOfWeek(isoDateAddDays(baseMonday, 7))];

  // Build per-day availability lists. Source slot is excluded; occupied slots are
  // shown as disabled buttons (so the parent can still see what's planned there).
  const byDay = [];
  allDays.forEach(date => {
    if (date < todayIso) return;
    const slotStates = SLOTS.map(slot => {
      const isSource = date === fromCtx.fromDate && slot.id === fromCtx.fromSlot;
      const occupied = !!plans[`${user.id}-${date}-${slot.id}`];
      return { slot, available: !isSource && !occupied, isSource, occupied };
    });
    if (slotStates.some(s => s.available)) byDay.push({ date, slotStates });
  });

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:90, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", maxHeight:"82vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:"1px solid #f0f0f0" }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontWeight:900, fontSize:18, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
              Move {fromCtx.food?.name || "this plan"}
            </div>
            <div style={{ fontSize:11, color:"#999", fontWeight:700, marginTop:2 }}>Pick an empty slot</div>
          </div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999", flexShrink:0, marginLeft:10 }}>✕</button>
        </div>

        <div style={{ overflowY:"auto", padding:"12px 20px", flex:1 }}>
          {byDay.length === 0 ? (
            <div style={{ textAlign:"center", padding:"40px 20px", color:"#bbb", fontSize:13, fontWeight:700 }}>
              No empty slots in the next two weeks.<br/>Remove a plan elsewhere first.
            </div>
          ) : byDay.map(({ date, slotStates }) => {
            const isToday = date === todayIso;
            return (
              <div key={date} style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, fontWeight:800, color:isToday?theme.accent:"#bbb", letterSpacing:1, marginBottom:8 }}>
                  {friendlyDate(date).toUpperCase()}{isToday && " · TODAY"}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                  {slotStates.map(({ slot, available, isSource, occupied }) => (
                    <button key={slot.id}
                      disabled={!available}
                      onClick={() => available && onPick(date, slot.id)}
                      style={{
                        background: available ? theme.light : "#fafafa",
                        color: available ? theme.accent : "#ccc",
                        border: available ? `2px solid ${theme.accent}33` : "2px solid transparent",
                        borderRadius:14, padding:"10px 6px",
                        cursor: available ? "pointer" : "default",
                        fontFamily:"'Nunito',sans-serif",
                        display:"flex", flexDirection:"column", alignItems:"center", gap:3,
                        opacity: available ? 1 : 0.6,
                      }}>
                      <div style={{ fontSize:18 }}>{slot.emoji}</div>
                      <div style={{ fontSize:11, fontWeight:800 }}>{slot.label}</div>
                      <div style={{ fontSize:9, fontWeight:700, color:"#bbb", letterSpacing:0.3 }}>
                        {isSource ? "from here" : occupied ? "taken" : "free"}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Planner: bulk actions menu (bottom sheet from header button) ─────────────
function BulkActionsMenu({ otherUser, theme, onCopyWeek, onCopyDay, onCopyKid, onClose }) {
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:88, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", animation:"slideUp 0.25s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 16px", borderBottom:"1px solid #f0f0f0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>Bulk actions</div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
        </div>

        <div style={{ padding:"16px 20px 0", display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={onCopyWeek}
            style={{ width:"100%", background:theme.accent, color:"white", border:"none", borderRadius:16, padding:"14px", fontSize:15, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:`0 4px 14px ${theme.accent}55`, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            📅 Copy this week → next week
          </button>
          <button onClick={onCopyDay}
            style={{ width:"100%", background:theme.light, color:theme.accent, border:`2px solid ${theme.accent}33`, borderRadius:16, padding:"12px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            📋 Copy a day → another day
          </button>
          {otherUser && (
            <button onClick={onCopyKid}
              style={{ width:"100%", background:theme.light, color:theme.accent, border:`2px solid ${theme.accent}33`, borderRadius:16, padding:"12px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              👯 Copy from {otherUser.name}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Planner: copy preview + confirm modal ────────────────────────────────────
// Shows count of plans about to be copied, plus already-planned (no-op) and
// conflict counts. The Replace toggle only affects conflicts.
function CopyConfirmModal({ title, description, copyCount, sameFoodCount = 0, conflictCount, theme, onConfirm, onCancel }) {
  const [replace, setReplace] = useState(false);

  // If there are no plans to copy AND no conflicts to replace, the action is empty.
  // Tell the user instead of letting them tap Confirm into a no-op.
  const totalActionable = copyCount + (replace ? conflictCount : 0);

  return (
    <div onClick={onCancel} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:92, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", borderBottom:"1px solid #f0f0f0" }}>
          <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>{title}</div>
          {description && <div style={{ fontSize:12, color:"#999", fontWeight:700, marginTop:4 }}>{description}</div>}
        </div>

        <div style={{ padding:"16px 20px" }}>
          <div style={{ background:theme.light, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ fontSize:13, fontWeight:800, color:theme.dark }}>📥 Will copy</div>
            <div style={{ fontSize:22, fontWeight:900, color:theme.accent }}>{copyCount}</div>
          </div>
          {sameFoodCount > 0 && (
            <div style={{ background:"#F0F8F0", borderRadius:16, padding:"12px 16px", marginBottom:10, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div style={{ fontSize:13, fontWeight:800, color:"#5A8A5A" }}>✓ Already planned</div>
              <div style={{ fontSize:18, fontWeight:900, color:"#5A8A5A" }}>{sameFoodCount}</div>
            </div>
          )}
          {conflictCount > 0 && (
            <>
              <div style={{ background:"#FFF7E5", borderRadius:16, padding:"12px 16px", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ fontSize:13, fontWeight:800, color:"#D88A1A" }}>⚠️ Different food planned</div>
                <div style={{ fontSize:18, fontWeight:900, color:"#D88A1A" }}>{conflictCount}</div>
              </div>
              <button onClick={()=>setReplace(r=>!r)}
                style={{ width:"100%", background:replace?theme.accent:"#f5f5f5", color:replace?"white":"#666", border:"none", borderRadius:14, padding:"12px", fontSize:13, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                <span style={{ fontSize:16 }}>{replace ? "☑️" : "⬜"}</span>
                Replace existing plans
              </button>
            </>
          )}
          {!conflictCount && <div style={{ height:14 }}/>}

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onCancel}
              style={{ flex:1, background:"white", color:"#666", border:"2px solid #e0e0e0", borderRadius:14, padding:"14px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
              Cancel
            </button>
            <button onClick={()=>onConfirm({ replace })}
              disabled={totalActionable === 0}
              style={{ flex:1.4, background:totalActionable===0?"#ccc":theme.accent, color:"white", border:"none", borderRadius:14, padding:"14px", fontSize:14, fontWeight:900, cursor:totalActionable===0?"default":"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:totalActionable===0?"none":`0 4px 14px ${theme.accent}55` }}>
              {totalActionable === 0 ? (sameFoodCount > 0 ? "Already up to date" : "Nothing to copy") : `Copy ${totalActionable}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Planner: day picker (used for source + destination of copy-day-to-day) ───
function DayPickerModal({ title, subtitle, allowPast, plans, userId, theme, onPick, onCancel }) {
  const todayIso   = today();
  const baseMonday = mondayOf(todayIso);
  const allDays    = [...daysOfWeek(baseMonday), ...daysOfWeek(isoDateAddDays(baseMonday, 7))];

  return (
    <div onClick={onCancel} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:91, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", maxHeight:"82vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", borderBottom:"1px solid #f0f0f0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>{title}</div>
            {subtitle && <div style={{ fontSize:12, color:"#999", fontWeight:700, marginTop:2 }}>{subtitle}</div>}
          </div>
          <button onClick={onCancel} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999", flexShrink:0, marginLeft:10 }}>✕</button>
        </div>

        <div style={{ overflowY:"auto", padding:"12px 20px", flex:1 }}>
          {allDays.map(date => {
            const isPast    = date < todayIso;
            const disabled  = isPast && !allowPast;
            const isToday   = date === todayIso;
            const planCount = SLOTS.filter(s => plans[`${userId}-${date}-${s.id}`]).length;
            const dt        = new Date(date + "T12:00:00");
            const wkday     = dt.toLocaleDateString("en-GB", { weekday:"long" });
            const daymon    = dt.toLocaleDateString("en-GB", { day:"numeric", month:"short" });
            return (
              <button key={date}
                disabled={disabled}
                onClick={()=>!disabled && onPick(date)}
                style={{ width:"100%", background:disabled?"#fafafa":"white", border:isToday?`2px solid ${theme.accent}`:"2px solid #f0f0f0", borderRadius:14, padding:"12px 14px", marginBottom:8, cursor:disabled?"default":"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, opacity:disabled?0.5:1 }}>
                <div style={{ textAlign:"left" }}>
                  <div style={{ fontSize:14, fontWeight:900, color:isToday?theme.accent:"#333" }}>
                    {wkday}{isToday && " · TODAY"}
                  </div>
                  <div style={{ fontSize:11, fontWeight:700, color:"#999", marginTop:1 }}>{daymon}</div>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  {planCount > 0 ? (
                    <div style={{ background:theme.light, color:theme.accent, borderRadius:10, padding:"3px 10px", fontSize:11, fontWeight:900 }}>
                      {planCount} planned
                    </div>
                  ) : (
                    <div style={{ fontSize:11, fontWeight:700, color:"#bbb" }}>empty</div>
                  )}
                  {!disabled && <div style={{ fontSize:18, color:"#ccc", fontWeight:900 }}>›</div>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Planner: cross-kid copy library mismatch resolver ────────────────────────
// `missing` is a list of { foodId, name, emoji, heroPhotoId, category } from the
// SOURCE kid's library that aren't in the destination kid's library yet.
function LibraryMismatchModal({ destName, srcName, missing, theme, onConfirm, onCancel }) {
  // Default: all checked. Unchecking removes both the food-create AND any plan
  // that references that food.
  const [checked, setChecked] = useState(()=>{
    const init = {};
    missing.forEach(m => { init[m.foodId] = true; });
    return init;
  });

  const toggleAll = (val) => {
    const next = {};
    missing.forEach(m => { next[m.foodId] = val; });
    setChecked(next);
  };
  const toggle = (id) => setChecked(c => ({ ...c, [id]: !c[id] }));

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const allOn  = checkedCount === missing.length;

  return (
    <div onClick={onCancel} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:92, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 28px", maxHeight:"86vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", borderBottom:"1px solid #f0f0f0" }}>
          <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>Add foods to {destName}'s library?</div>
          <div style={{ fontSize:12, color:"#999", fontWeight:700, marginTop:4 }}>
            {missing.length} food{missing.length===1?"":"s"} from {srcName}'s plan {missing.length===1?"isn't":"aren't"} in {destName}'s library yet.
            Uncheck any that shouldn't be added — those plans will be skipped.
          </div>
        </div>

        <div style={{ padding:"10px 20px 6px", display:"flex", justifyContent:"flex-end" }}>
          <button onClick={()=>toggleAll(!allOn)}
            style={{ background:"transparent", color:theme.accent, border:"none", padding:"4px 8px", fontSize:12, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
            {allOn ? "Uncheck all" : "Check all"}
          </button>
        </div>

        <div style={{ overflowY:"auto", padding:"0 20px 12px", flex:1 }}>
          {missing.map(m => {
            const isOn = !!checked[m.foodId];
            return (
              <button key={m.foodId} onClick={()=>toggle(m.foodId)}
                style={{ width:"100%", background:isOn?theme.light:"white", border:isOn?`2px solid ${theme.accent}`:"2px solid #f0f0f0", borderRadius:14, padding:"10px 12px", marginBottom:8, cursor:"pointer", fontFamily:"'Nunito',sans-serif", display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ fontSize:18 }}>{isOn ? "☑️" : "⬜"}</div>
                <PhotoThumb photoId={m.heroPhotoId} size={36} fallback={m.emoji} radius={10}/>
                <div style={{ flex:1, minWidth:0, textAlign:"left" }}>
                  <div style={{ fontSize:14, fontWeight:900, color:"#333", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{m.name}</div>
                  <div style={{ fontSize:10, fontWeight:700, color:"#bbb", letterSpacing:0.3, marginTop:1 }}>{(m.category||"any").toUpperCase()}</div>
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ padding:"12px 20px 0", borderTop:"1px solid #f0f0f0", display:"flex", gap:10 }}>
          <button onClick={onCancel}
            style={{ flex:1, background:"white", color:"#666", border:"2px solid #e0e0e0", borderRadius:14, padding:"14px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
            Cancel
          </button>
          <button onClick={()=>onConfirm(checked)}
            style={{ flex:1.4, background:theme.accent, color:"white", border:"none", borderRadius:14, padding:"14px", fontSize:14, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", boxShadow:`0 4px 14px ${theme.accent}55` }}>
            Continue ({checkedCount} food{checkedCount===1?"":"s"})
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Planner screen ────────────────────────────────────────────────────────────
function PlannerScreen({ user, otherUser, library, plans, theme, onBack, onSetPlan, onClearPlan, onMovePlan, onAddNewFood, onBulkCopy }) {
  const [tab, setTab] = useState("this"); // "this" | "next"
  const [pickerCtx, setPickerCtx] = useState(null); // { date, slot }
  const [actionCtx, setActionCtx] = useState(null); // { date, slot, food }
  const [moveCtx,   setMoveCtx]   = useState(null); // { fromDate, fromSlot, food }
  const [addNewCtx, setAddNewCtx] = useState(null); // { date, slot } — set when user taps "+ Add brand new food" inside the picker

  // Bulk action state machine — only one of these is non-null at a time.
  const [bulkOpen,    setBulkOpen]    = useState(false);                // top-level bulk menu
  const [copyDayCtx,  setCopyDayCtx]  = useState(null);                 // { phase: "src"|"dest", srcDate? }
  const [confirmCtx,  setConfirmCtx]  = useState(null);                 // { kind, payload, copyCount, conflictCount }
  const [mismatchCtx, setMismatchCtx] = useState(null);                 // { missing, plansToCopy, replace }

  const todayIso   = today();
  const baseMonday = mondayOf(todayIso);
  const weekStart  = tab === "this" ? baseMonday : isoDateAddDays(baseMonday, 7);
  const days       = daysOfWeek(weekStart);

  const userLib  = library[user.id] || [];
  const findFood = id => userLib.find(f => f.foodId === id);

  // Counts shown in header subtitle. Excludes past days from the denominator
  // so the ratio reflects what the parent can actually act on.
  const editableDays = days.filter(d => d >= todayIso);
  const totalSlots   = editableDays.length * SLOTS.length;
  const plannedCount = editableDays.reduce((sum, date) =>
    sum + SLOTS.filter(s => plans[`${user.id}-${date}-${s.id}`]).length, 0);

  const handleCellTap = (date, slot) => {
    if (date < todayIso) return;
    const planEntry = plans[`${user.id}-${date}-${slot}`];
    if (planEntry) {
      const food = findFood(planEntry.foodId);
      setActionCtx({ date, slot, food });
    } else {
      setPickerCtx({ date, slot });
    }
  };

  const handlePick = (food) => {
    if (!pickerCtx) return;
    onSetPlan(user.id, pickerCtx.date, pickerCtx.slot, food.foodId);
    setPickerCtx(null);
  };

  const handleChangeFood = () => {
    if (!actionCtx) return;
    setPickerCtx({ date: actionCtx.date, slot: actionCtx.slot });
    setActionCtx(null);
  };

  const handleRemove = () => {
    if (!actionCtx) return;
    onClearPlan(user.id, actionCtx.date, actionCtx.slot);
    setActionCtx(null);
  };

  const handleMoveOpen = () => {
    if (!actionCtx) return;
    setMoveCtx({ fromDate: actionCtx.date, fromSlot: actionCtx.slot, food: actionCtx.food });
    setActionCtx(null);
  };

  const handleMoveTarget = (toDate, toSlot) => {
    if (!moveCtx) return;
    onMovePlan(user.id, moveCtx.fromDate, moveCtx.fromSlot, toDate, toSlot);
    setMoveCtx(null);
  };

  // "+ Add a brand new food" tap inside the picker — close the picker, open the
  // AddFoodModal, then on save add to library AND set the plan in one action.
  const handleAddNewOpen = () => {
    if (!pickerCtx) return;
    setAddNewCtx({ date: pickerCtx.date, slot: pickerCtx.slot });
    setPickerCtx(null);
  };

  const handleSaveNewFromPlanner = (foodData) => {
    if (!addNewCtx) return;
    onAddNewFood(foodData);
    onSetPlan(user.id, addNewCtx.date, addNewCtx.slot, foodData.foodId);
    setAddNewCtx(null);
  };

  // ── Bulk action handlers ─────────────────────────────────────────────────
  // Each "Copy XXX" entry point computes a payload + counts, then opens
  // CopyConfirmModal. Confirmation runs onBulkCopy and shows a toast.

  const todayMonday    = mondayOf(today());
  const thisWeekDays   = daysOfWeek(todayMonday);
  const nextWeekDays   = daysOfWeek(isoDateAddDays(todayMonday, 7));

  // Build a list of { fromDate, fromSlot, toDate, toSlot, foodId } pairs that
  // we'd want to apply, given a source-day-list and destination-day-list of
  // equal length (mapped index-for-index). Slots with no source plan become
  // `null` foodId entries so the consumer can still know about the slot
  // (used for "skip vs replace" comparison against destination).
  const buildPairs = (srcDays, destDays, srcUserId) => {
    const pairs = [];
    srcDays.forEach((srcDate, i) => {
      const destDate = destDays[i];
      SLOTS.forEach(s => {
        const src = plans[`${srcUserId}-${srcDate}-${s.id}`];
        if (!src) return;
        pairs.push({ fromDate: srcDate, fromSlot: s.id, toDate: destDate, toSlot: s.id, foodId: src.foodId });
      });
    });
    return pairs;
  };

  // Split pairs against destination state. Three buckets:
  // - copyable: destination empty → will be written
  // - sameFood: destination already has the same food → no-op, hidden from UX
  // - conflicting: destination has a DIFFERENT food → user can opt to replace
  const splitByConflict = (pairs, destUserId) => {
    const todayIso2 = today();
    const copyable = [];
    const sameFood = [];
    const conflicting = [];
    pairs.forEach(p => {
      if (p.toDate < todayIso2) return; // can never write into past
      const existing = plans[`${destUserId}-${p.toDate}-${p.toSlot}`];
      if (!existing) copyable.push(p);
      else if (existing.foodId === p.foodId) sameFood.push(p);
      else conflicting.push(p);
    });
    return { copyable, sameFood, conflicting };
  };

  const openWeekToWeek = () => {
    setBulkOpen(false);
    const pairs = buildPairs(thisWeekDays, nextWeekDays, user.id);
    const { copyable, sameFood, conflicting } = splitByConflict(pairs, user.id);
    setConfirmCtx({
      kind: "week",
      title: "Copy this week → next week",
      description: `${user.name}'s plans from this week will be copied to the same days next week.`,
      copyable, sameFood, conflicting,
    });
  };

  const openDayToDay = () => {
    setBulkOpen(false);
    setCopyDayCtx({ phase: "src" });
  };

  const onPickSrcDay = (srcDate) => {
    setCopyDayCtx({ phase: "dest", srcDate });
  };

  const onPickDestDay = (destDate) => {
    if (!copyDayCtx?.srcDate) return;
    const srcDate = copyDayCtx.srcDate;
    setCopyDayCtx(null);
    if (destDate === srcDate) return; // no-op
    const pairs = buildPairs([srcDate], [destDate], user.id);
    const { copyable, sameFood, conflicting } = splitByConflict(pairs, user.id);
    const dt1 = new Date(srcDate + "T12:00:00");
    const dt2 = new Date(destDate + "T12:00:00");
    setConfirmCtx({
      kind: "day",
      title: `Copy ${dt1.toLocaleDateString("en-GB",{weekday:"short", day:"numeric", month:"short"})} → ${dt2.toLocaleDateString("en-GB",{weekday:"short", day:"numeric", month:"short"})}`,
      description: `Plans from ${dt1.toLocaleDateString("en-GB",{weekday:"long"})} will be copied to ${dt2.toLocaleDateString("en-GB",{weekday:"long"})}.`,
      copyable, sameFood, conflicting,
    });
  };

  const openCrossKid = () => {
    setBulkOpen(false);
    if (!otherUser) return;
    // Source = otherUser's plans for the CURRENT TAB only (per spec).
    const tabDays = tab === "this" ? thisWeekDays : nextWeekDays;
    const pairs = buildPairs(tabDays, tabDays, otherUser.id);
    if (pairs.length === 0) {
      setConfirmCtx({
        kind: "crossKid",
        title: `Copy from ${otherUser.name}`,
        description: `${otherUser.name} has no plans for ${tab==="this"?"this":"next"} week.`,
        copyable: [], sameFood: [], conflicting: [],
      });
      return;
    }
    // Identify which source foods aren't in destination's library.
    const destLib = library[user.id] || [];
    const srcLib  = library[otherUser.id] || [];
    const destIds = new Set(destLib.map(f => f.foodId));
    const missingIds = new Set();
    pairs.forEach(p => { if (!destIds.has(p.foodId)) missingIds.add(p.foodId); });
    if (missingIds.size > 0) {
      const missing = [...missingIds].map(id => srcLib.find(f => f.foodId === id)).filter(Boolean);
      // Open the mismatch resolver. Plans are stashed in mismatchCtx until the
      // user resolves; when they confirm, we filter by their checkbox choices
      // and roll into the standard confirm modal.
      setMismatchCtx({ pairs, missing });
      return;
    }
    // No mismatches — straight to confirm.
    const { copyable, sameFood, conflicting } = splitByConflict(pairs, user.id);
    setConfirmCtx({
      kind: "crossKid",
      title: `Copy from ${otherUser.name}`,
      description: `Copies ${otherUser.name}'s ${tab==="this"?"this":"next"} week plans into ${user.name}'s planner.`,
      copyable, sameFood, conflicting,
    });
  };

  // After the user resolves library mismatches, drop any pairs whose foods
  // were unchecked and proceed to the confirm modal.
  const onResolveMismatch = (checkedMap) => {
    if (!mismatchCtx) return;
    const { pairs, missing } = mismatchCtx;
    const destLib    = library[user.id] || [];
    const destIds    = new Set(destLib.map(f => f.foodId));
    const willCreate = missing.filter(m => checkedMap[m.foodId]);
    const willCreateIds = new Set(willCreate.map(m => m.foodId));
    // A plan's food is acceptable if either (a) destination already has it, or
    // (b) the user just checked it for creation.
    const filtered = pairs.filter(p => destIds.has(p.foodId) || willCreateIds.has(p.foodId));
    const { copyable, sameFood, conflicting } = splitByConflict(filtered, user.id);
    setMismatchCtx(null);
    setConfirmCtx({
      kind: "crossKid",
      title: `Copy from ${otherUser.name}`,
      description: willCreate.length > 0
        ? `${willCreate.length} new food${willCreate.length===1?"":"s"} will be added to ${user.name}'s library, then plans will be copied.`
        : `Copies ${otherUser.name}'s plans into ${user.name}'s planner.`,
      copyable, sameFood, conflicting,
      foodsToCreate: willCreate, // root will create these before applying plans
    });
  };

  const onConfirmCopy = ({ replace }) => {
    if (!confirmCtx) return;
    const { copyable, conflicting, foodsToCreate } = confirmCtx;
    const finalPairs = replace ? [...copyable, ...conflicting] : copyable;
    onBulkCopy({
      destUserId: user.id,
      pairs: finalPairs.map(p => ({ toDate:p.toDate, toSlot:p.toSlot, foodId:p.foodId })),
      foodsToCreate: foodsToCreate || [],
    });
    setConfirmCtx(null);
  };

  // Featured food for the picker — when re-picking via "Change food", show the
  // current plan at the top so it's easy to keep it. When picking for an empty
  // cell, no featured food.
  const pickerFeatured = (() => {
    if (!pickerCtx) return null;
    const planEntry = plans[`${user.id}-${pickerCtx.date}-${pickerCtx.slot}`];
    return planEntry ? findFood(planEntry.foodId) : null;
  })();

  return (
    <div style={{ minHeight:"100vh", background:theme.light, fontFamily:"'Nunito',sans-serif", maxWidth:430, margin:"0 auto", paddingBottom:60 }}>
      <div style={{ background:theme.accent, borderRadius:"0 0 36px 36px", padding:"20px 20px 28px", color:"white", boxShadow:`0 8px 30px ${theme.accent}55` }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <GhostButton onClick={onBack}>← Back</GhostButton>
          <div style={{ textAlign:"center", flex:1 }}>
            <div style={{ fontWeight:900, fontSize:20 }}>📋 {user.name}'s Planner</div>
            <div style={{ fontSize:12, opacity:0.85, fontWeight:700, marginTop:2 }}>
              {totalSlots > 0 ? `${plannedCount}/${totalSlots} meals planned` : "All days are in the past"}
            </div>
          </div>
          <button onClick={()=>setBulkOpen(true)}
            style={{ background:"rgba(255,255,255,0.18)", color:"white", border:"1.5px solid rgba(255,255,255,0.3)", borderRadius:14, padding:"7px 12px", fontSize:12, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", whiteSpace:"nowrap" }}>
            ⚡ Bulk
          </button>
        </div>
      </div>

      <div style={{ padding:"16px 16px 0" }}>
        <div style={{ display:"flex", gap:6, marginBottom:14, background:"white", padding:6, borderRadius:16, boxShadow:"0 4px 14px rgba(0,0,0,0.05)" }}>
          {[
            { id:"this", label:"This week" },
            { id:"next", label:"Next week" },
          ].map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)}
              style={{ flex:1, background:tab===t.id?theme.accent:"transparent", color:tab===t.id?"white":"#999", border:"none", borderRadius:11, padding:"10px", fontSize:13, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif" }}>
              {t.label}
            </button>
          ))}
        </div>

        {days.map(date => (
          <PlannerDayRow key={date} user={user} date={date} todayIso={todayIso}
            library={library} plans={plans} theme={theme}
            onCellTap={handleCellTap}/>
        ))}
      </div>

      {pickerCtx && (
        <FoodPicker user={user} library={library}
          slot={pickerCtx.slot} theme={theme}
          featuredFood={pickerFeatured}
          onPick={handlePick}
          onAddNew={handleAddNewOpen}
          onClose={()=>setPickerCtx(null)}/>
      )}

      {addNewCtx && (
        <AddFoodModal user={user} theme={theme}
          defaultCategory={addNewCtx.slot}
          onSave={handleSaveNewFromPlanner}
          onClose={()=>setAddNewCtx(null)}/>
      )}

      {actionCtx && (
        <PlanActionMenu actionCtx={actionCtx} theme={theme}
          onMove={handleMoveOpen}
          onChange={handleChangeFood}
          onRemove={handleRemove}
          onClose={()=>setActionCtx(null)}/>
      )}

      {moveCtx && (
        <MoveTargetPicker user={user} plans={plans} fromCtx={moveCtx} theme={theme}
          onPick={handleMoveTarget}
          onClose={()=>setMoveCtx(null)}/>
      )}

      {bulkOpen && (
        <BulkActionsMenu otherUser={otherUser} theme={theme}
          onCopyWeek={openWeekToWeek}
          onCopyDay={openDayToDay}
          onCopyKid={openCrossKid}
          onClose={()=>setBulkOpen(false)}/>
      )}

      {copyDayCtx && copyDayCtx.phase === "src" && (
        <DayPickerModal title="Copy from which day?"
          subtitle="Pick the source day (past days OK)"
          allowPast={true} plans={plans} userId={user.id} theme={theme}
          onPick={onPickSrcDay}
          onCancel={()=>setCopyDayCtx(null)}/>
      )}

      {copyDayCtx && copyDayCtx.phase === "dest" && (
        <DayPickerModal title="Copy to which day?"
          subtitle={`From ${new Date(copyDayCtx.srcDate+"T12:00:00").toLocaleDateString("en-GB",{weekday:"long", day:"numeric", month:"short"})}`}
          allowPast={false} plans={plans} userId={user.id} theme={theme}
          onPick={onPickDestDay}
          onCancel={()=>setCopyDayCtx(null)}/>
      )}

      {mismatchCtx && otherUser && (
        <LibraryMismatchModal destName={user.name} srcName={otherUser.name}
          missing={mismatchCtx.missing} theme={theme}
          onConfirm={onResolveMismatch}
          onCancel={()=>setMismatchCtx(null)}/>
      )}

      {confirmCtx && (
        <CopyConfirmModal
          title={confirmCtx.title}
          description={confirmCtx.description}
          copyCount={confirmCtx.copyable.length}
          sameFoodCount={(confirmCtx.sameFood || []).length}
          conflictCount={confirmCtx.conflicting.length}
          theme={theme}
          onConfirm={onConfirmCopy}
          onCancel={()=>setConfirmCtx(null)}/>
      )}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function TheDailyFood() {
  const [screen,    setScreen]    = useState("select");
  const [user,      setUser]      = useState(null);
  const [users,     setUsers]     = useState(DEFAULT_USERS);
  const [library,   setLibrary]   = useState({});
  const [plans,     setPlans]     = useState({});
  const [logs,      setLogs]      = useState({});
  const [xp,        setXp]        = useState({});
  const [syncing,   setSyncing]   = useState(false);
  const [pickerSlot,setPickerSlot]= useState(null); // null | "breakfast" | "lunch" | "dinner" | "snack"
  const [addNewFor, setAddNewFor] = useState(null); // null | "library" | "log:slot"
  const [logModal,  setLogModal]  = useState(null); // null | { food, slot, slotKey, existingLog }
  const [slotActions,setSlotActions] = useState(null); // null | { slot, log, food }
  const [photoView, setPhotoView] = useState(null); // null | photoId
  const [toast,     setToast]     = useState(null);
  const [eatingReaction, setEatingReaction] = useState(null); // null | { food, rating, wasNew, xp, animal, aColor }
  const [levelUp,   setLevelUp]   = useState(null); // null | { newLevel, oldLevel, animal, aColor, nextTier, theme }

  const persistUsers   = useCallback(nu => { setUsers(nu);   lsSet(LS.profiles, nu); }, []);
  const persistLibrary = useCallback(nl => { setLibrary(nl); lsSet(LS.library,  nl); }, []);
  const persistPlans   = useCallback(np => { setPlans(np);   lsSet(LS.plans,    np); }, []);
  const persistLogs    = useCallback(nl => { setLogs(nl);    lsSet(LS.logs,     nl); }, []);
  const persistXp      = useCallback(nx => { setXp(nx);      lsSet(LS.xp,       nx); }, []);

  // ── Init: local-first, then sync ────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const localUsers   = lsGet(LS.profiles, DEFAULT_USERS);
      const localLibrary = lsGet(LS.library, {});
      const localPlans   = migratePlans(lsGet(LS.plans, {}));
      const localLogs    = lsGet(LS.logs, {});
      const localXp      = lsGet(LS.xp, {});

      setUsers(localUsers); setLibrary(localLibrary);
      setPlans(localPlans); setLogs(localLogs); setXp(localXp);
      // Persist migrated plans back to localStorage so subsequent reads in this
      // session don't repeatedly migrate. Also overwrites any partial-migrated state.
      lsSet(LS.plans, localPlans);
      setSyncing(true);

      const todayIso = today();
      const weekIso  = mondayOf(todayIso);
      const bulk = await bulkFetch(todayIso, weekIso);

      if (bulk) {
        const { profiles, library:rLib, plans:rPlans, logs:rLogs, xp:rXp } = bulk;
        const lastSync = lsGet(LS.lastSync, null);

        // Profiles — merge: remote wins for stable fields, but local totalXp wins if higher.
        // outfitId and parentPin MUST be listed here. They were previously absent,
        // which made them local-only: a look chosen on one device could never
        // reach another, because the merge simply never read them off the wire.
        const mergedUsers = localUsers.map(u => {
          const r = profiles.find(p => p.userId === u.id);
          if (!r) return u;
          return { ...u,
            name:          r.name          || u.name,
            animal:        r.animal        || u.animal,
            themeId:       r.themeId       || u.themeId,
            animalColorId: r.animalColorId || u.animalColorId,
            outfitId:      r.outfitId      || u.outfitId || "none",
            parentPin:     r.parentPin     || u.parentPin || "",
            level:         Math.max(r.level || 1, u.level || 1),
            totalXp:       Math.max(r.totalXp || 0, u.totalXp || 0),
          };
        });
        // Push any default users not yet on the server. Seeding a brand new
        // profile is the one case where look and stats are written together.
        mergedUsers.forEach(u => {
          if (!profiles.find(p => p.userId === u.id)) {
            postProfileLook(u);
            postProfileStats(u, u.totalXp || 0, u.level || 1);
          }
        });
        persistUsers(mergedUsers);

        // Library — start with local, drop stale local-only entries (deleted elsewhere),
        // then overlay everything from cloud.
        const mergedLib = {};
        Object.entries(localLibrary).forEach(([uid, items]) => {
          const remoteForUser = rLib.filter(r => r.userId === uid);
          mergedLib[uid] = items.filter(localItem => {
            const onRemote = remoteForUser.some(r => r.foodId === localItem.foodId);
            if (onRemote) return true;
            return shouldKeepLocal(localItem, lastSync);
          });
        });
        rLib.forEach(item => {
          if (!mergedLib[item.userId]) mergedLib[item.userId] = [];
          const idx = mergedLib[item.userId].findIndex(f => f.foodId === item.foodId);
          if (idx === -1) mergedLib[item.userId].push(item);
          else mergedLib[item.userId][idx] = item;
        });
        persistLibrary(mergedLib);

        // Plans — drop stale local-only entries (deleted elsewhere), then overlay remote.
        // Plans now carry updatedAt; same tombstone-aware pattern as logs/library/xp.
        // Cloud rows with foodId="" don't reach here (the GS handler deletes them);
        // but defend against any stray empty-foodId rows just in case.
        const remotePlanKeys = new Set(rPlans.map(p => `${p.userId}-${p.date}-${p.slot}`));
        const mergedPlans = {};
        Object.entries(localPlans).forEach(([key, plan]) => {
          if (remotePlanKeys.has(key)) return; // remote will overlay below
          if (shouldKeepLocal(plan, lastSync)) mergedPlans[key] = plan;
        });
        rPlans.forEach(p => {
          if (!p.foodId) return;
          mergedPlans[`${p.userId}-${p.date}-${p.slot}`] = {
            foodId: p.foodId,
            updatedAt: p.updatedAt || "",
          };
        });
        persistPlans(mergedPlans);

        // Logs — drop stale local-only entries (deleted elsewhere), then overlay remote.
        const remoteLogKeys = new Set(rLogs.map(l => `${l.userId}-${l.date}-${l.slot}`));
        const mergedLogs = {};
        Object.entries(localLogs).forEach(([key, log]) => {
          if (remoteLogKeys.has(key)) return; // will be overwritten by remote below
          if (shouldKeepLocal(log, lastSync)) mergedLogs[key] = log;
        });
        rLogs.forEach(l => {
          mergedLogs[`${l.userId}-${l.date}-${l.slot}`] = l;
        });
        persistLogs(mergedLogs);

        // XP — drop stale local-only entries, then overlay remote.
        const remoteXpKeys = new Set(rXp.map(x => `${x.userId}-${x.date}`));
        const mergedXp = {};
        Object.entries(localXp).forEach(([key, x]) => {
          if (remoteXpKeys.has(key)) return;
          if (shouldKeepLocal(x, lastSync)) mergedXp[key] = x;
        });
        rXp.forEach(x => { mergedXp[`${x.userId}-${x.date}`] = x; });
        persistXp(mergedXp);

        // Recompute each user's totalXp and level from the freshly-merged XP map,
        // BUT floor it against the merged profile's totalXp. The backend only
        // returns 60 days of XP rows, so the windowed recompute undercounts for
        // anyone with older history — summing it raw made totals shrink each day.
        // The merged profile totalXp is already Math.max(remote, local), i.e. the
        // cumulative high-water mark, and it travels via the sheet so new/empty
        // devices inherit the correct total too. The windowed recompute can still
        // raise the total (new logs) but can no longer erase pre-window history.
        // Trade-off: deleting a log older than 60 days won't subtract its XP.
        const recomputedUsers = mergedUsers.map(u => {
          const recomputed = recomputeUserTotalXp(u.id, mergedXp);
          const total = Math.max(recomputed, u.totalXp || 0);
          return { ...u, totalXp: total, level: levelFromXp(total) };
        });
        persistUsers(recomputedUsers);
        // Sync the recomputed values back to cloud so other devices converge.
        recomputedUsers.forEach(u => {
          postProfileStats(u, u.totalXp, u.level);
        });

        // Stamp this successful sync. Future merges will use this to identify
        // local records that the cloud has now forgotten about.
        lsSet(LS.lastSync, new Date().toISOString());
      }

      setSyncing(false);
    };
    init();
  }, []);

  // ── Service worker auto-update ─────────────────────────────────────────────
  // The generated workbox service worker already calls skipWaiting() and
  // clientsClaim(), so a new worker takes control as soon as the browser
  // finds one. The problem is that nothing ever goes looking. An installed
  // Android PWA resumed from the background does not re-navigate, so it can
  // sit on a months-old bundle indefinitely — which is what made deploys
  // appear not to land, and what let two devices run different code.
  //
  // This effect closes that gap entirely inside the app, so it survives
  // rebuilds. sw.js itself is build-generated and must never be hand-edited.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Reload once when a new worker takes over. The guard matters: on a very
    // first install there is no previous controller, and reloading then would
    // be pointless churn. reloadedRef stops any chance of a reload loop.
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    }

    // Ask the browser to re-check sw.js. Cheap: a single conditional request.
    const checkForUpdate = () => {
      navigator.serviceWorker.getRegistration()
        .then(reg => { if (reg) reg.update(); })
        .catch(() => {});
    };

    checkForUpdate();                       // on load
    const onVisible = () => {               // and on every resume from background
      if (document.visibilityState === "visible") checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── Android back button ────────────────────────────────────────────────────
  useEffect(() => {
    if (screen === "select") history.replaceState({ screen:"select" }, "");
    else history.pushState({ screen }, "");
  }, [screen]);

  useEffect(() => {
    const onPop = () => {
      setScreen("select"); setPickerSlot(null); setAddNewFor(null); setLogModal(null);
      setSlotActions(null); setPhotoView(null);
      history.pushState({ screen:"select" }, "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const showToast = (msg, ms=2200) => {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  };

  const cu = users.find(u => u.id === user?.id) || user;

  // ── Action handlers ────────────────────────────────────────────────────────

  const handlePickFood = (food) => {
    const slot = pickerSlot;
    setPickerSlot(null);

    // If snack, generate unique slot key like snack-1, snack-2…
    let slotKey = slot;
    if (slot === "snack") {
      let i = 1;
      while (logs[`${cu.id}-${today()}-snack-${i}`]) i++;
      slotKey = `snack-${i}`;
    }

    const existingLog = logs[`${cu.id}-${today()}-${slotKey}`];
    setLogModal({ food, slot, slotKey, existingLog });
  };

  const handleSaveLog = ({ rating, wasNew, photoId, xpEarned }) => {
    const { food, slot, slotKey, existingLog } = logModal;
    setLogModal(null);

    // For edits, keep the original date so editing a past meal stays on its day.
    // For new logs, use today.
    const dateIso = existingLog?.date || today();
    const logKey  = `${cu.id}-${dateIso}-${slotKey}`;
    const isEdit  = !!existingLog;

    const newLog = {
      userId: cu.id, date: dateIso, slot: slotKey,
      foodId: food.foodId, rating, wasNew, photoId: photoId || "",
      xpEarned,
      // Preserve original loggedAt timestamp on edit; new logs get fresh stamp.
      loggedAt: existingLog?.loggedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const newLogs = { ...logs, [logKey]: newLog };
    persistLogs(newLogs);
    postFireForget("log", { ...newLog });

    // Library update: only increment timesEaten and set firstTried on a NEW log.
    // On edits we still update the row (in case wasNew toggled) but don't bump counters.
    const userLib = [...(library[cu.id] || [])];
    const fIdx = userLib.findIndex(f => f.foodId === food.foodId);
    if (fIdx !== -1) {
      const f = userLib[fIdx];
      const updated = isEdit ? {
        ...f,
        // Keep tried/firstTried/timesEaten as they were
        tried: f.tried,
        firstTried: f.firstTried,
        timesEaten: f.timesEaten || 0,
        updatedAt: new Date().toISOString(),
      } : {
        ...f,
        tried: true,
        firstTried: f.firstTried || dateIso,
        timesEaten: (f.timesEaten || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      userLib[fIdx] = updated;
      persistLibrary({ ...library, [cu.id]: userLib });
      if (!isEdit) postFireForget("library", { userId:cu.id, ...updated });
    }

    // Recompute day XP and total XP.
    // Total is updated by DELTA (today's new dayXp minus today's previous dayXp)
    // rather than re-summing the whole XP map — the local map only holds ~60
    // days after a sync, so a full re-sum silently erased pre-window history
    // and pushed the shrunken total to the sheet on every log. Today's entry is
    // always in-window, so the delta is exact, and edits that lower a rating
    // still correctly subtract.
    const prevDayXp = (xp[`${cu.id}-${dateIso}`]?.dailyXp) || 0;
    const dayStats = recomputeDayXp(cu.id, dateIso, newLogs);
    const newXp = { ...xp, [`${cu.id}-${dateIso}`]: { userId:cu.id, date:dateIso, ...dayStats, updatedAt: new Date().toISOString() } };
    persistXp(newXp);
    postFireForget("xp", { userId:cu.id, date:dateIso, ...dayStats });

    const total = Math.max(0, (cu.totalXp || 0) + (dayStats.dailyXp - prevDayXp));
    const newLevel = levelFromXp(total);
    const oldLevel = cu.level || 1;
    const updatedUser = { ...cu, totalXp: total, level: newLevel };
    persistUsers(users.map(u => u.id === cu.id ? updatedUser : u));
    setUser(updatedUser);
    postProfileStats(updatedUser, total, newLevel);

    if (newLevel > oldLevel) {
      setLevelUp({
        newLevel, oldLevel,
        animal: cu.animal || "cat",
        aColor: userAColor(cu),
        outfitId: cu.outfitId || "none",
        nextTier: islandNextTier(newLevel),
        nextOutfit: nextOutfitUnlock(newLevel),
        theme: userTheme(cu),
      });
    }

    if (isEdit) {
      showToast(`Updated · ${xpEarned} XP`);
    } else if (slotKey.startsWith("snack")) {
      showToast(`+${xpEarned} XP! 🎉`);
    } else {
      setEatingReaction({
        food, rating, wasNew, xp: xpEarned,
        animal: cu.animal || "cat",
        aColor: userAColor(cu),
        outfitId: cu.outfitId || "none",
      });
    }
  };

  const handleSaveNewFood = (foodData) => {
    addFoodToLibrary(foodData);

    const ctx = addNewFor;
    setAddNewFor(null);

    // If we came from logging, jump straight into the log modal with this food
    if (ctx && ctx.startsWith("log:")) {
      const slot = ctx.split(":")[1];
      let slotKey = slot;
      if (slot === "snack") {
        let i = 1;
        while (logs[`${cu.id}-${today()}-snack-${i}`]) i++;
        slotKey = `snack-${i}`;
      }
      // Auto-set wasNew = true since they just added it
      setLogModal({ food: { ...foodData, tried: false }, slot, slotKey, existingLog:null });
    }
  };

  // Library-add helper. Used by handleSaveNewFood and by the planner's
  // add-food-then-plan flow. Pure side effect — no modal/screen routing.
  const addFoodToLibrary = (foodData) => {
    const newFood = { ...foodData, userId: cu.id, updatedAt: new Date().toISOString() };
    const userLib = [...(library[cu.id] || []), newFood];
    persistLibrary({ ...library, [cu.id]: userLib });
    postFireForget("library", { userId:cu.id, ...newFood });
  };

  const handleDeleteFood = (foodId) => {
    const userLib = (library[cu.id] || []).filter(f => f.foodId !== foodId);
    persistLibrary({ ...library, [cu.id]: userLib });
    postFireForget("library_delete", { userId:cu.id, foodId });
  };

  // ── Plan handlers ──────────────────────────────────────────────────────────

  const handleSetPlan = (userId, date, slot, foodId) => {
    const key = `${userId}-${date}-${slot}`;
    const updatedAt = new Date().toISOString();
    const next = { ...plans, [key]: { foodId, updatedAt } };
    persistPlans(next);
    postFireForget("plan", { userId, date, slot, foodId });
  };

  const handleClearPlan = (userId, date, slot) => {
    const key = `${userId}-${date}-${slot}`;
    if (!plans[key]) return;
    const next = { ...plans };
    delete next[key];
    persistPlans(next);
    postFireForget("plan", { userId, date, slot, foodId: "" });
  };

  const handleMovePlan = (userId, fromDate, fromSlot, toDate, toSlot) => {
    const fromKey = `${userId}-${fromDate}-${fromSlot}`;
    const toKey   = `${userId}-${toDate}-${toSlot}`;
    const src = plans[fromKey];
    if (!src) return;
    // Refuse moving onto an already-occupied target. Caller should prevent this,
    // but defend in depth.
    if (plans[toKey]) return;
    const updatedAt = new Date().toISOString();
    const next = { ...plans };
    delete next[fromKey];
    next[toKey] = { foodId: src.foodId, updatedAt };
    persistPlans(next);
    postFireForget("plan", { userId, date: fromDate, slot: fromSlot, foodId: "" });
    postFireForget("plan", { userId, date: toDate,   slot: toSlot,   foodId: src.foodId });
  };

  // Bulk apply: create any missing foods first (with shared heroPhotoId from
  // source kid as confirmed in spec), then write all plan pairs in one library
  // + plans state update, then fire-and-forget per-row to the backend.
  const handleBulkCopy = ({ destUserId, pairs, foodsToCreate }) => {
    const nowIso = new Date().toISOString();

    // 1. Add foods to destination's library (locally + cloud).
    let nextLibrary = library;
    if (foodsToCreate && foodsToCreate.length > 0) {
      const destLib = [...(library[destUserId] || [])];
      foodsToCreate.forEach(src => {
        // If destination already has this foodId (race condition), skip.
        if (destLib.some(f => f.foodId === src.foodId)) return;
        const newFood = {
          userId: destUserId,
          foodId: src.foodId,        // share the same id so heroPhotoId reference is implicit
          name:   src.name,
          emoji:  src.emoji || "🍽️",
          category: src.category || "any",
          heroPhotoId: src.heroPhotoId || "",   // shared photo id (spec decision)
          tried: false,
          firstTried: "",
          timesEaten: 0,
          updatedAt: nowIso,
        };
        destLib.push(newFood);
        postFireForget("library", newFood);
      });
      nextLibrary = { ...library, [destUserId]: destLib };
      persistLibrary(nextLibrary);
    }

    // 2. Apply all plan pairs.
    const nextPlans = { ...plans };
    pairs.forEach(p => {
      const key = `${destUserId}-${p.toDate}-${p.toSlot}`;
      nextPlans[key] = { foodId: p.foodId, updatedAt: nowIso };
      postFireForget("plan", { userId: destUserId, date: p.toDate, slot: p.toSlot, foodId: p.foodId });
    });
    persistPlans(nextPlans);

    showToast(`Copied ${pairs.length} plan${pairs.length===1?"":"s"} ✓`);
  };

  const handleDeleteLog = (logKey) => {
    const log = logs[logKey];
    if (!log) return;
    const newLogs = { ...logs };
    delete newLogs[logKey];
    persistLogs(newLogs);
    postFireForget("log", { userId:cu.id, date:log.date, slot:log.slot, foodId:"" });

    // Recompute XP — delta-based, same reasoning as handleSaveLog: the local
    // XP map is windowed post-sync, so a full re-sum erases old history.
    const prevDayXp = (xp[`${cu.id}-${log.date}`]?.dailyXp) || 0;
    const dayStats = recomputeDayXp(cu.id, log.date, newLogs);
    const newXp = { ...xp, [`${cu.id}-${log.date}`]: { userId:cu.id, date:log.date, ...dayStats, updatedAt: new Date().toISOString() } };
    persistXp(newXp);
    postFireForget("xp", { userId:cu.id, date:log.date, ...dayStats });

    const total = Math.max(0, (cu.totalXp || 0) + (dayStats.dailyXp - prevDayXp));
    const updatedUser = { ...cu, totalXp: total, level: levelFromXp(total) };
    persistUsers(users.map(u => u.id === cu.id ? updatedUser : u));
    setUser(updatedUser);
    postProfileStats(updatedUser, total, updatedUser.level);
  };

  const handleSaveSettings = (updated) => {
    persistUsers(users.map(u => u.id === updated.id ? updated : u));
    setUser(updated);
    postProfileLook(updated);
    setScreen("today");
  };

  // ── Slot popup actions (tap a logged main meal slot) ───────────────────────
  const handleSlotAction = (slotId, log, food) => {
    setSlotActions({ slot: slotId, log, food });
  };

  const handleRelog = () => {
    const { slot, log, food } = slotActions;
    setSlotActions(null);
    // Reopen the log modal pre-filled. slotKey same as slot for B/L/D.
    setLogModal({ food, slot, slotKey: slot, existingLog: log });
  };

  const handleViewPhoto = () => {
    const { log, food } = slotActions;
    const id = log.photoId || food?.heroPhotoId;
    if (id) setPhotoView(id);
  };

  const handleDeleteFromPopup = () => {
    const { log } = slotActions;
    const logKey = `${cu.id}-${log.date}-${log.slot}`;
    setSlotActions(null);
    handleDeleteLog(logKey);
  };

  // ── CSS ────────────────────────────────────────────────────────────────────
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
    @keyframes float    { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-7px)} }
    @keyframes pop      { 0%{transform:scale(0.7) translateY(10px);opacity:0} 100%{transform:scale(1) translateY(0);opacity:1} }
    @keyframes toastUp  { 0%{opacity:0;transform:translateY(20px)} 15%{opacity:1;transform:translateY(0)} 85%{opacity:1;transform:translateY(0)} 100%{opacity:0;transform:translateY(-10px)} }
    @keyframes fadeUp   { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
    @keyframes slideUp  { from{transform:translateY(100%)} to{transform:translateY(0)} }
    @keyframes spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
    @keyframes sparklePulse {
      0%,100% { box-shadow:0 0 0 0 rgba(255,179,0,0.45); transform:scale(1); }
      50%     { box-shadow:0 0 0 6px rgba(255,179,0,0); transform:scale(1.025); }
    }
    /* Island animations */
    @keyframes islandSway          { 0%,100% { transform:rotate(-2deg); } 50% { transform:rotate(2deg); } }
    @keyframes islandRipple        { 0%,100% { opacity:0.2; transform:scaleX(0.85); } 50% { opacity:0.85; transform:scaleX(1.15); } }
    @keyframes islandFriendBounce  { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-4px); } }
    @keyframes islandSmoke         { 0% { opacity:0.8; transform:translate(0,0); } 100% { opacity:0; transform:translate(6px,-12px); } }
    @keyframes islandBoatBob       { 0%,100% { transform:translateY(0) rotate(-2deg); } 50% { transform:translateY(-3px) rotate(2deg); } }
    @keyframes islandLightPulse    { 0%,100% { opacity:0.5; } 50% { opacity:1; } }
    @keyframes islandSparkle       { 0%,100% { opacity:0.3; transform:scale(0.7); } 50% { opacity:1; transform:scale(1.2); } }
    @keyframes islandCloudsDrift   { from { transform:translateX(0); } to { transform:translateX(-200px); } }
    @keyframes islandAnimalBounce  { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-6px); } }
    @keyframes islandTap           { 0% { transform:scale(1) rotate(0); } 30% { transform:scale(1.12) rotate(-3deg); } 60% { transform:scale(1.08) rotate(3deg); } 100% { transform:scale(1) rotate(0); } }
    @keyframes islandLilyDrift     { 0%,100% { transform:translateX(0); } 50% { transform:translateX(4px); } }
    @keyframes islandStarTwinkle   { 0%,100% { opacity:0.4; transform:scale(0.85); } 50% { opacity:1; transform:scale(1.15); } }
    @keyframes islandBirdsDrift    { from { transform:translateX(0); } to { transform:translateX(1700px); } }
    @keyframes islandUnlockBurst   { 0% { opacity:0; transform:scale(0.4) rotate(-10deg); } 60% { opacity:1; transform:scale(1.1) rotate(5deg); } 100% { opacity:1; transform:scale(1) rotate(0); } }
    @keyframes islandUnlockSparkle { 0% { opacity:0; transform:scale(0); } 50% { opacity:1; transform:scale(1); } 100% { opacity:0; transform:scale(1.6); } }
    /* Eating reaction + level-up cinematic */
    @keyframes reactJump {
      0%   { transform: translateY(0) scale(1); }
      20%  { transform: translateY(-50px) scale(1.08); }
      40%  { transform: translateY(0) scale(0.92); }
      55%  { transform: translateY(-20px) scale(1.04); }
      70%  { transform: translateY(0) scale(0.97); }
      100% { transform: translateY(0) scale(1); }
    }
    @keyframes reactNod {
      0%,100% { transform: rotate(0); }
      20% { transform: rotate(8deg); }
      40% { transform: rotate(-6deg); }
      60% { transform: rotate(5deg); }
      80% { transform: rotate(-2deg); }
    }
    @keyframes reactWince {
      0%,100% { transform: scale(1) translateX(0) rotate(0); }
      15% { transform: scale(0.9) translateX(-8px) rotate(-3deg); }
      30% { transform: scale(0.92) translateX(8px) rotate(3deg); }
      45% { transform: scale(0.93) translateX(-6px) rotate(-2deg); }
      60% { transform: scale(0.94) translateX(6px) rotate(2deg); }
    }
    @keyframes foodFalls {
      0%   { transform: translateY(0) scale(1) rotate(0); opacity: 1; }
      100% { transform: translateY(110px) scale(0.3) rotate(20deg); opacity: 0; }
    }
    @keyframes heartFly {
      0%   { transform: translateX(0) scale(0); opacity: 0; }
      20%  { opacity: 1; }
      100% { transform: translateX(180px) scale(1.6); opacity: 0; }
    }
    @keyframes thumbUpFloat {
      0%   { transform: translateY(20px) scale(0); opacity: 0; }
      60%  { transform: translateY(-10px) scale(1.2); opacity: 1; }
      100% { transform: translateY(-30px) scale(1); opacity: 0; }
    }
    @keyframes yuckPuff {
      0%   { transform: scale(0); opacity: 0; }
      30%  { transform: scale(1.5); opacity: 0.9; }
      100% { transform: scale(2.5) translateY(-30px); opacity: 0; }
    }
    @keyframes newRingPulse {
      0%,100% { transform: scale(1); opacity: 0.7; }
      50%     { transform: scale(1.12); opacity: 1; }
    }
    @keyframes popIn {
      0%   { transform: scale(0); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes popText {
      0%   { transform: scale(0.4); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes levelBigBounce {
      0%   { transform: scale(0); opacity: 0; }
      50%  { transform: scale(1.35); opacity: 1; }
      75%  { transform: scale(0.92); }
      100% { transform: scale(1); }
    }
    @keyframes levelAnimalPop {
      0%   { transform: translateY(60px) scale(0.4); opacity: 0; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    @keyframes confettiFall {
      0%   { transform: translateY(-20px) rotate(0deg); }
      100% { transform: translateY(110vh) rotate(720deg); }
    }
    @keyframes twinkle {
      0%,100% { opacity: 0.3; transform: scale(0.7); }
      50%     { opacity: 1; transform: scale(1.3); }
    }
    @keyframes catTailWag {
      0%,100% { transform: rotate(-10deg); }
      50%     { transform: rotate(10deg);  }
    }
    @keyframes dogTailWag {
      0%,100% { transform: rotate(-28deg); }
      50%     { transform: rotate(28deg);  }
    }
    @keyframes unicornTailFlow {
      0%,100% { transform: rotate(-8deg); }
      50%     { transform: rotate(8deg);  }
    }
    /* Arm animations — pivot around shoulder joint */
    @keyframes waveArmRight {
      0%,100% { transform: rotate(22deg); }    /* rest: arm out-down slightly */
      28%     { transform: rotate(-100deg); }  /* arm fully raised */
      50%     { transform: rotate(-92deg); }   /* hold up */
      72%     { transform: rotate(22deg); }    /* back down */
    }
    @keyframes waveArmLeft {
      0%,100% { transform: rotate(-22deg); }   /* rest: arm out-down slightly */
      40%     { transform: rotate(18deg); }    /* sway forward */
      80%     { transform: rotate(-22deg); }   /* back */
    }
    @keyframes idleArmRight {
      0%,100% { transform: rotate(22deg); }
      50%     { transform: rotate(14deg); }
    }
    @keyframes idleArmLeft {
      0%,100% { transform: rotate(-22deg); }
      50%     { transform: rotate(-14deg); }
    }
    /* Whole-body trick animations */
    @keyframes trickWave {
      0%,100% { transform: translateY(0) rotate(0); }
      20%     { transform: translateY(-7px) rotate(-6deg); }
      40%     { transform: translateY(-7px) rotate(6deg); }
      60%     { transform: translateY(-4px) rotate(-3deg); }
      80%     { transform: translateY(0) rotate(2deg); }
    }
    @keyframes trickDance {
      0%,100% { transform: translateX(0) rotate(0) scaleY(1); }
      12%     { transform: translateX(-13px) rotate(-11deg) scaleY(1.04); }
      25%     { transform: translateX(0) rotate(0) scaleY(1); }
      37%     { transform: translateX(13px) rotate(11deg) scaleY(1.04); }
      50%     { transform: translateX(0) rotate(0) scaleY(1); }
      62%     { transform: translateX(-8px) rotate(-7deg) scaleY(1.02); }
      75%     { transform: translateX(0) rotate(0) scaleY(1); }
      87%     { transform: translateX(8px) rotate(7deg) scaleY(1.02); }
    }
      0%,100% { transform: translateY(0); }
      50%     { transform: translateY(-3px); }
    }
    /* Tap tricks */
    @keyframes trickJump {
      0%   { transform: translateY(0) rotate(0) scale(1); }
      30%  { transform: translateY(-40px) rotate(-15deg) scale(1.1); }
      60%  { transform: translateY(-20px) rotate(10deg) scale(1.05); }
      100% { transform: translateY(0) rotate(0) scale(1); }
    }
    @keyframes trickWobble {
      0%,100% { transform: rotate(0) scale(1); }
      20%  { transform: rotate(-18deg) scale(1.05); }
      40%  { transform: rotate(18deg) scale(1.05); }
      60%  { transform: rotate(-12deg) scale(1.02); }
      80%  { transform: rotate(8deg) scale(1.01); }
    }
    @keyframes trickShimmy {
      0%,100% { transform: translateX(0) scale(1); }
      15%  { transform: translateX(-14px) scale(1.04); }
      30%  { transform: translateX(14px) scale(1.04); }
      45%  { transform: translateX(-10px) scale(1.02); }
      60%  { transform: translateX(10px) scale(1.02); }
      75%  { transform: translateX(-4px); }
    }
    @keyframes trickSpin {
      0%   { transform: rotate(0) scale(1); }
      50%  { transform: rotate(180deg) scale(1.15); }
      100% { transform: rotate(360deg) scale(1); }
    }
    /* Night animations */
    @keyframes nightBreath {
      0%,100% { transform: scale(1) translateY(0); }
      50%     { transform: scale(1.04) translateY(-3px); }
    }
    @keyframes nightZ {
      0%   { opacity: 0; transform: translateY(0) scale(0.7); }
      20%  { opacity: 1; }
      80%  { opacity: 0.8; }
      100% { opacity: 0; transform: translateY(-22px) scale(1.2); }
    }
    /* Friend ball bounce arc */
    @keyframes friendBallArc {
      0%   { transform: translateX(0) translateY(0); }
      25%  { transform: translateX(80px) translateY(-28px); }
      50%  { transform: translateX(160px) translateY(0); }
      75%  { transform: translateX(80px) translateY(-28px); }
      100% { transform: translateX(0) translateY(0); }
    }
    @keyframes friendFaceLeft {
      0%,45%,100% { transform: scaleX(1); }
      50%,95%     { transform: scaleX(-1); }
    }
    @keyframes friendFaceRight {
      0%,45%,100% { transform: scaleX(-1); }
      50%,95%     { transform: scaleX(1); }
    }
    .island-tappable               { cursor:pointer; transform-box:fill-box; transform-origin:50% 100%; }
    .island-tappable.island-wobbling { animation:islandTap 0.5s cubic-bezier(0.4,0,0.2,1); }
  `;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (screen === "select") return (
    <>
      <style>{CSS}</style>
      {syncing && <div style={{ position:"fixed", top:12, right:12, zIndex:200, background:"rgba(0,0,0,0.55)", borderRadius:20, padding:"6px 12px", color:"white", fontSize:11, fontWeight:700, display:"flex", alignItems:"center", gap:6 }}><span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span> Syncing…</div>}
      <SelectScreen users={users} logs={logs} library={library}
        onSelect={u=>{setUser(u); setScreen("today");}}
        onSettings={u=>{setUser(u); setScreen("settings");}}
        onPlanner={u=>{setUser(u); setScreen("planner");}}/>
    </>
  );

  if (screen === "settings") return (
    <><style>{CSS}</style><SettingsScreen user={cu} onSave={handleSaveSettings} onBack={()=>setScreen("today")}/></>
  );

  const theme  = userTheme(cu);
  const aColor = userAColor(cu);

  if (screen === "library") return (
    <><style>{CSS}</style>
      <LibraryScreen user={cu} library={library} logs={logs} theme={theme}
        onBack={()=>setScreen("today")}
        onAddNew={()=>setAddNewFor("library")}
        onDeleteFood={handleDeleteFood}/>
      {addNewFor === "library" && (
        <AddFoodModal user={cu} theme={theme} onSave={handleSaveNewFood} onClose={()=>setAddNewFor(null)}/>
      )}
    </>
  );

  if (screen === "planner") return (
    <><style>{CSS}</style>
      <PlannerScreen user={cu} otherUser={users.find(u=>u.id!==cu.id)} library={library} plans={plans} theme={theme}
        onBack={()=>setScreen("select")}
        onSetPlan={handleSetPlan}
        onClearPlan={handleClearPlan}
        onMovePlan={handleMovePlan}
        onAddNewFood={addFoodToLibrary}
        onBulkCopy={handleBulkCopy}/>
    </>
  );

  if (screen === "week") return (
    <><style>{CSS}</style>
      <WeekScreen user={cu} library={library} plans={plans} logs={logs} theme={theme} onBack={()=>setScreen("today")}/>
    </>
  );

  if (screen === "island") return (
    <><style>{CSS}</style>
      <IslandScreen user={cu} aColor={aColor} theme={theme}
        level={cu.level||1} totalXp={cu.totalXp||0}
        onBack={()=>setScreen("today")}/>
    </>
  );

  // Default: today
  return (
    <>
      <style>{CSS}</style>
      <TodayScreen user={cu} library={library} plans={plans} logs={logs}
        theme={theme} aColor={aColor}
        onBack={()=>setScreen("select")}
        onLog={slot=>setPickerSlot(slot)}
        onSlotAction={handleSlotAction}
        onAddNew={()=>setAddNewFor("library")}
        onLibrary={()=>setScreen("library")}
        onWeek={()=>setScreen("week")}
        onSettings={()=>setScreen("settings")}
        onIsland={()=>setScreen("island")}
        onDeleteLog={handleDeleteLog}/>

      {slotActions && (
        <LoggedSlotActions slot={slotActions.slot} log={slotActions.log} food={slotActions.food} theme={theme}
          onView={handleViewPhoto}
          onRelog={handleRelog}
          onDelete={handleDeleteFromPopup}
          onClose={()=>setSlotActions(null)}/>
      )}

      {photoView && <PhotoViewer photoId={photoView} onClose={()=>setPhotoView(null)}/>}

      {pickerSlot && (() => {
        // If the slot has a plan, surface the planned food at the top of the picker.
        // Snacks don't carry plans, so featuredFood is null for them.
        const planEntry = pickerSlot !== "snack" ? plans[`${cu.id}-${today()}-${pickerSlot}`] : null;
        const userLib = library[cu.id] || [];
        const featuredFood = planEntry ? userLib.find(f => f.foodId === planEntry.foodId) : null;
        return (
          <FoodPicker user={cu} library={library} slot={pickerSlot==="snack"?null:pickerSlot} theme={theme}
            featuredFood={featuredFood}
            onPick={handlePickFood}
            onAddNew={()=>{setAddNewFor(`log:${pickerSlot}`); setPickerSlot(null);}}
            onClose={()=>setPickerSlot(null)}/>
        );
      })()}

      {addNewFor && addNewFor.startsWith("log:") && (
        <AddFoodModal user={cu} theme={theme}
          defaultCategory={addNewFor.split(":")[1]==="snack"?"snack":addNewFor.split(":")[1]}
          onSave={handleSaveNewFood}
          onClose={()=>setAddNewFor(null)}/>
      )}

      {logModal && (
        <LogMealModal user={cu} theme={theme} food={logModal.food} slot={logModal.slot} existingLog={logModal.existingLog}
          onSave={handleSaveLog} onClose={()=>setLogModal(null)}/>
      )}

      {toast && (
        <div style={{ position:"fixed", bottom:60, left:"50%", transform:"translateX(-50%)", background:theme.accent, color:"white", fontWeight:900, fontSize:15, borderRadius:20, padding:"12px 24px", animation:"toastUp 2.2s ease forwards", pointerEvents:"none", zIndex:200, boxShadow:`0 6px 24px ${theme.accent}88`, whiteSpace:"nowrap" }}>
          {toast}
        </div>
      )}

      {/* Eating reaction shows first; level-up cinematic queued behind it */}
      {eatingReaction && (
        <EatingReactionOverlay reaction={eatingReaction} onDismiss={()=>setEatingReaction(null)}/>
      )}
      {!eatingReaction && levelUp && (
        <LevelUpCinematic data={levelUp} onDismiss={()=>setLevelUp(null)}/>
      )}
    </>
  );
}
