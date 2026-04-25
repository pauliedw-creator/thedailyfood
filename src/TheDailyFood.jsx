import { useState, useEffect, useCallback, useRef } from "react";

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

// Level N → N+1 needs (25 + 25*N) XP. Cumulative XP for Level N = 12.5*N*(N+1)
function xpForLevel(n) { return Math.round(12.5 * n * (n + 1)); }
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
  { id:"fish",    label:"Fish",    emoji:"🐟" },
  { id:"unicorn", label:"Unicorn", emoji:"🦄" },
  { id:"rabbit",  label:"Rabbit",  emoji:"🐰" },
];

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

function AnimalFace({ animal, pct, color, size=118 }) {
  switch(animal) {
    case "dog":     return <DogFace     pct={pct} color={color} size={size}/>;
    case "fish":    return <FishFace    pct={pct} color={color} size={size}/>;
    case "unicorn": return <UnicornFace pct={pct} color={color} size={size}/>;
    case "rabbit":  return <RabbitFace  pct={pct} color={color} size={size}/>;
    default:        return <CatFace     pct={pct} color={color} size={size}/>;
  }
}

// ── localStorage layer ────────────────────────────────────────────────────────
const LS = {
  profiles: "tdf_profiles",
  library:  "tdf_library",   // { userId: [{...food}] }
  plans:    "tdf_plans",     // { "userId-date-slot": foodId }
  logs:     "tdf_logs",      // { "userId-date-slot": {...log} }
  xp:       "tdf_xp",        // { "userId-date": {...xp} }
};

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
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
function FoodPicker({ user, library, slot, onPick, onAddNew, onClose, theme }) {
  const [filter, setFilter] = useState("all"); // all | tried | untried | category
  const userLib = library[user.id] || [];

  let shown = userLib;
  if (filter === "tried")    shown = userLib.filter(f => f.tried);
  if (filter === "untried")  shown = userLib.filter(f => !f.tried);
  if (filter === "matching" && slot) {
    shown = userLib.filter(f => f.category === slot || f.category === "any");
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:80, display:"flex", flexDirection:"column", justifyContent:"flex-end" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()}
        style={{ background:"white", borderRadius:"28px 28px 0 0", padding:"0 0 24px", maxHeight:"85vh", display:"flex", flexDirection:"column", animation:"slideUp 0.28s cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 4px" }}>
          <div style={{ width:36, height:4, borderRadius:2, background:"#e0e0e0" }}/>
        </div>
        <div style={{ padding:"8px 20px 12px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontWeight:900, fontSize:18, color:"#333" }}>Pick a food</div>
          <button onClick={onClose} style={{ background:"#f5f5f5", border:"none", borderRadius:"50%", width:32, height:32, fontSize:16, cursor:"pointer", color:"#999" }}>✕</button>
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
          <button onClick={onAddNew}
            style={{ width:"100%", background:theme.light, border:`2px dashed ${theme.accent}`, borderRadius:16, padding:"14px", color:theme.accent, fontSize:14, fontWeight:900, cursor:"pointer", fontFamily:"'Nunito',sans-serif", marginBottom:12 }}>
            + Add a brand new food
          </button>

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

// ── Log meal modal (after picking food) ───────────────────────────────────────
function LogMealModal({ user, theme, food, slot, existingLog, onSave, onClose }) {
  const [rating, setRating]   = useState(existingLog?.rating || null);
  const [wasNew, setWasNew]   = useState(existingLog?.wasNew ?? !food.tried);
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
            <button onClick={()=>setWasNew(w=>!w)}
              style={{ flex:1, background:wasNew?"linear-gradient(135deg,#FFD700,#FFA500)":"#fafafa", color:wasNew?"#5a4000":"#999", border:wasNew?"none":"2px solid #f0f0f0", borderRadius:16, padding:"12px", cursor:"pointer", fontSize:13, fontWeight:900, fontFamily:"'Nunito',sans-serif" }}>
              ✨ {wasNew ? "First time! +25 XP" : "Mark as new"}
            </button>
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
function WeekScreen({ user, library, logs, theme, onBack }) {
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
                  const food = log ? findFood(log.foodId) : null;
                  return (
                    <div key={slot} style={{ flex:1, background:log?theme.light:"#fafafa", borderRadius:10, padding:"6px", display:"flex", alignItems:"center", gap:6, minWidth:0 }}>
                      <PhotoThumb photoId={log?.photoId || food?.heroPhotoId} size={28} fallback={food?.emoji || SLOTS.find(s=>s.id===slot)?.emoji} radius={6}/>
                      <div style={{ minWidth:0, flex:1 }}>
                        <div style={{ fontSize:9, fontWeight:800, color:"#bbb", letterSpacing:0.5 }}>{slot.slice(0,4).toUpperCase()}</div>
                        <div style={{ fontSize:11, fontWeight:700, color:log?"#333":"#bbb", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
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
  const pt  = resolveTheme(themeId);
  const pac = resolveAnimal(colorId).color;

  const handleSave = () => {
    onSave({ ...user, name: name.trim() || user.name, animal, themeId, animalColorId: colorId });
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
              <AnimalFace animal={animal} pct={0.85} color={pac} size={90}/>
            </div>
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
function SelectScreen({ users, logs, library, theme0, onSelect, onSettings }) {
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
                  <AnimalFace animal={u.animal||"cat"} pct={completed/3} color={aColor} size={66}/>
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

              <button onClick={e=>{e.stopPropagation(); onSettings(u);}}
                style={{ position:"absolute", top:-6, right:-6, width:36, height:36, borderRadius:"50%", background:"rgba(255,255,255,0.14)", border:"1.5px solid rgba(255,255,255,0.25)", color:"white", fontSize:15, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(8px)" }}>
                ⚙️
              </button>
            </div>
          );
        })}
      </div>

      <p style={{ color:"rgba(255,255,255,0.18)", fontSize:11, textAlign:"center", margin:"0 0 16px", fontWeight:600 }}>☁️ Cloud sync enabled · Phase 1</p>
    </div>
  );
}

// ── Today screen (main) ───────────────────────────────────────────────────────
function TodayScreen({ user, library, plans, logs, theme, aColor, onBack, onLog, onAddNew, onLibrary, onWeek, onSettings, onDeleteLog }) {
  const todayIso = today();
  const userLib = library[user.id] || [];
  const findFood = id => userLib.find(f => f.foodId === id);
  const animalInfo = ANIMALS.find(a => a.id === (user.animal || "cat"));

  const slotData = SLOTS.map(slot => {
    const log = logs[`${user.id}-${todayIso}-${slot.id}`];
    const planFoodId = plans[`${user.id}-${todayIso}-${slot.id}`];
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
        <div style={{ animation:"float 3.5s ease-in-out infinite" }}>
          <AnimalFace animal={user.animal||"cat"} pct={moodPct} color={aColor} size={130}/>
        </div>
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
          <SlotCard key={slot.id} slot={slot} log={log} plan={plan} food={food} color={theme.accent} dark={theme.dark} light={theme.light} onTap={()=>onLog(slot.id)}/>
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
  const [logModal,  setLogModal]  = useState(null); // null | { food, slot, existingLog }
  const [toast,     setToast]     = useState(null);

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
      const localPlans   = lsGet(LS.plans, {});
      const localLogs    = lsGet(LS.logs, {});
      const localXp      = lsGet(LS.xp, {});

      setUsers(localUsers); setLibrary(localLibrary);
      setPlans(localPlans); setLogs(localLogs); setXp(localXp);
      setSyncing(true);

      const todayIso = today();
      const weekIso  = mondayOf(todayIso);
      const bulk = await bulkFetch(todayIso, weekIso);

      if (bulk) {
        const { profiles, library:rLib, plans:rPlans, logs:rLogs, xp:rXp } = bulk;

        // Profiles — merge: remote wins for stable fields, but local totalXp wins if higher
        const mergedUsers = localUsers.map(u => {
          const r = profiles.find(p => p.userId === u.id);
          if (!r) return u;
          return { ...u,
            name:          r.name          || u.name,
            animal:        r.animal        || u.animal,
            themeId:       r.themeId       || u.themeId,
            animalColorId: r.animalColorId || u.animalColorId,
            level:         Math.max(r.level || 1, u.level || 1),
            totalXp:       Math.max(r.totalXp || 0, u.totalXp || 0),
          };
        });
        // Push any default users not yet on the server
        mergedUsers.forEach(u => {
          if (!profiles.find(p => p.userId === u.id)) {
            postFireForget("profile", { userId:u.id, name:u.name, animal:u.animal, themeId:u.themeId, animalColorId:u.animalColorId, level:u.level||1, totalXp:u.totalXp||0, parentPin:"" });
          }
        });
        persistUsers(mergedUsers);

        // Library — remote-wins per (userId, foodId), but keep local-only entries
        const mergedLib = { ...localLibrary };
        rLib.forEach(item => {
          if (!mergedLib[item.userId]) mergedLib[item.userId] = [];
          const idx = mergedLib[item.userId].findIndex(f => f.foodId === item.foodId);
          if (idx === -1) mergedLib[item.userId].push(item);
          else mergedLib[item.userId][idx] = item;
        });
        persistLibrary(mergedLib);

        // Plans — remote-wins per key
        const mergedPlans = { ...localPlans };
        rPlans.forEach(p => { mergedPlans[`${p.userId}-${p.date}-${p.slot}`] = p.foodId; });
        persistPlans(mergedPlans);

        // Logs — remote-wins per key (logs are facts)
        const mergedLogs = { ...localLogs };
        rLogs.forEach(l => {
          // Snacks come back with slot like "snack-1" already; trust the key as-is
          mergedLogs[`${l.userId}-${l.date}-${l.slot}`] = l;
        });
        persistLogs(mergedLogs);

        // XP — remote-wins per key
        const mergedXp = { ...localXp };
        rXp.forEach(x => { mergedXp[`${x.userId}-${x.date}`] = x; });
        persistXp(mergedXp);
      }

      setSyncing(false);
    };
    init();
  }, []);

  // ── Android back button ────────────────────────────────────────────────────
  useEffect(() => {
    if (screen === "select") history.replaceState({ screen:"select" }, "");
    else history.pushState({ screen }, "");
  }, [screen]);

  useEffect(() => {
    const onPop = () => {
      setScreen("select"); setPickerSlot(null); setAddNewFor(null); setLogModal(null);
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
    const { food, slot, slotKey } = logModal;
    setLogModal(null);

    const dateIso = today();
    const logKey  = `${cu.id}-${dateIso}-${slotKey}`;
    const newLog = {
      userId: cu.id, date: dateIso, slot: slotKey,
      foodId: food.foodId, rating, wasNew, photoId: photoId || "",
      xpEarned, loggedAt: new Date().toISOString(),
    };

    const newLogs = { ...logs, [logKey]: newLog };
    persistLogs(newLogs);
    postFireForget("log", { ...newLog });

    // Update library — mark tried, increment timesEaten
    const userLib = [...(library[cu.id] || [])];
    const fIdx = userLib.findIndex(f => f.foodId === food.foodId);
    if (fIdx !== -1) {
      const f = userLib[fIdx];
      const updated = {
        ...f,
        tried: true,
        firstTried: f.firstTried || dateIso,
        timesEaten: (f.timesEaten || 0) + 1,
      };
      userLib[fIdx] = updated;
      persistLibrary({ ...library, [cu.id]: userLib });
      postFireForget("library", { userId:cu.id, ...updated });
    }

    // Recompute day XP and total XP
    const dayStats = recomputeDayXp(cu.id, dateIso, newLogs);
    const newXp = { ...xp, [`${cu.id}-${dateIso}`]: { userId:cu.id, date:dateIso, ...dayStats } };
    persistXp(newXp);
    postFireForget("xp", { userId:cu.id, date:dateIso, ...dayStats });

    const total = recomputeUserTotalXp(cu.id, newXp);
    const newLevel = levelFromXp(total);
    const oldLevel = cu.level || 1;
    const updatedUser = { ...cu, totalXp: total, level: newLevel };
    persistUsers(users.map(u => u.id === cu.id ? updatedUser : u));
    setUser(updatedUser);
    postFireForget("profile", { userId:cu.id, name:updatedUser.name, animal:updatedUser.animal, themeId:updatedUser.themeId, animalColorId:updatedUser.animalColorId, level:newLevel, totalXp:total, parentPin:updatedUser.parentPin||"" });

    if (newLevel > oldLevel) {
      showToast(`🎉 LEVEL UP! You're Level ${newLevel}!`, 3500);
    } else {
      showToast(`+${xpEarned} XP! 🎉`);
    }
  };

  const handleSaveNewFood = (foodData) => {
    const newFood = { ...foodData, userId: cu.id };
    const userLib = [...(library[cu.id] || []), newFood];
    persistLibrary({ ...library, [cu.id]: userLib });
    postFireForget("library", { userId:cu.id, ...newFood });

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
      setLogModal({ food: { ...newFood, tried: false }, slot, slotKey, existingLog:null });
    }
  };

  const handleDeleteFood = (foodId) => {
    const userLib = (library[cu.id] || []).filter(f => f.foodId !== foodId);
    persistLibrary({ ...library, [cu.id]: userLib });
    postFireForget("library_delete", { userId:cu.id, foodId });
  };

  const handleDeleteLog = (logKey) => {
    const log = logs[logKey];
    if (!log) return;
    const newLogs = { ...logs };
    delete newLogs[logKey];
    persistLogs(newLogs);
    postFireForget("log", { userId:cu.id, date:log.date, slot:log.slot, foodId:"" });

    // Recompute XP
    const dayStats = recomputeDayXp(cu.id, log.date, newLogs);
    const newXp = { ...xp, [`${cu.id}-${log.date}`]: { userId:cu.id, date:log.date, ...dayStats } };
    persistXp(newXp);
    postFireForget("xp", { userId:cu.id, date:log.date, ...dayStats });

    const total = recomputeUserTotalXp(cu.id, newXp);
    const updatedUser = { ...cu, totalXp: total, level: levelFromXp(total) };
    persistUsers(users.map(u => u.id === cu.id ? updatedUser : u));
    setUser(updatedUser);
    postFireForget("profile", { userId:cu.id, name:updatedUser.name, animal:updatedUser.animal, themeId:updatedUser.themeId, animalColorId:updatedUser.animalColorId, level:updatedUser.level, totalXp:total, parentPin:updatedUser.parentPin||"" });
  };

  const handleSaveSettings = (updated) => {
    persistUsers(users.map(u => u.id === updated.id ? updated : u));
    setUser(updated);
    postFireForget("profile", { userId:updated.id, name:updated.name, animal:updated.animal, themeId:updated.themeId, animalColorId:updated.animalColorId, level:updated.level||1, totalXp:updated.totalXp||0, parentPin:updated.parentPin||"" });
    setScreen("today");
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
  `;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (screen === "select") return (
    <>
      <style>{CSS}</style>
      {syncing && <div style={{ position:"fixed", top:12, right:12, zIndex:200, background:"rgba(0,0,0,0.55)", borderRadius:20, padding:"6px 12px", color:"white", fontSize:11, fontWeight:700, display:"flex", alignItems:"center", gap:6 }}><span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span> Syncing…</div>}
      <SelectScreen users={users} logs={logs} library={library}
        onSelect={u=>{setUser(u); setScreen("today");}}
        onSettings={u=>{setUser(u); setScreen("settings");}}/>
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

  if (screen === "week") return (
    <><style>{CSS}</style>
      <WeekScreen user={cu} library={library} logs={logs} theme={theme} onBack={()=>setScreen("today")}/>
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
        onAddNew={()=>setAddNewFor("library")}
        onLibrary={()=>setScreen("library")}
        onWeek={()=>setScreen("week")}
        onSettings={()=>setScreen("settings")}
        onDeleteLog={handleDeleteLog}/>

      {pickerSlot && (
        <FoodPicker user={cu} library={library} slot={pickerSlot==="snack"?null:pickerSlot} theme={theme}
          onPick={handlePickFood}
          onAddNew={()=>{setAddNewFor(`log:${pickerSlot}`); setPickerSlot(null);}}
          onClose={()=>setPickerSlot(null)}/>
      )}

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
    </>
  );
}
