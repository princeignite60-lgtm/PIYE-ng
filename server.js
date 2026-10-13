"use strict";
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:5500,http://127.0.0.1:5500")
  .split(",").map(x => x.trim()).filter(Boolean);
if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET must be set to a random secret of at least 32 characters in production.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Configure a PostgreSQL database.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin not allowed by CORS."));
}, credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "X-CSRF-Token"] }));
app.use(express.json({ limit: "100kb", strict: true }));
app.use(session({
  name: "piye.sid", secret: process.env.SESSION_SECRET || "development-only-change-this-secret-before-deploying",
  resave: false, saveUninitialized: false, rolling: true,
  store: new PgSession({ pool, tableName: "piye_sessions", createTableIfMissing: true }),
  cookie: { httpOnly: true, secure: isProduction, sameSite: isProduction ? "none" : "lax", maxAge: 1000 * 60 * 60 * 24 * 7, path: "/" }
}));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many account attempts. Wait a little and try again." } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/api", apiLimiter);

async function initialise(){
 await pool.query(`CREATE TABLE IF NOT EXISTS piye_users (
   id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query("ALTER TABLE piye_users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''");
 await pool.query(`CREATE TABLE IF NOT EXISTS piye_progress (
   user_id BIGINT PRIMARY KEY REFERENCES piye_users(id) ON DELETE CASCADE,
   progress JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE TABLE IF NOT EXISTS piye_saved_words (
   user_id BIGINT NOT NULL REFERENCES piye_users(id) ON DELETE CASCADE,
   word TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   PRIMARY KEY(user_id, word)
 )`);
}
function normaliseEmail(value){return String(value||"").trim().toLowerCase();}
function validEmail(value){return value.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);}
function sessionUser(req){return req.session.user ? {id:req.session.user.id,email:req.session.user.email,name:req.session.user.name||''} : null;}
function requireAuth(req,res,next){if(!req.session.user)return res.status(401).json({error:"Please log in to continue."});next();}
function safeEqual(a,b){if(typeof a!=="string"||typeof b!=="string")return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function requireCsrf(req,res,next){
  const origin=req.get("origin");
  if(origin && !allowedOrigins.includes(origin))return res.status(403).json({error:"Request origin is not allowed."});
  if(!safeEqual(req.get("x-csrf-token"),req.session.csrfToken))return res.status(403).json({error:"Security token expired. Refresh the page and try again."});
  next();
}
app.get("/api/health",(req,res)=>res.json({ok:true,service:"PIYE API",version:"1.0.0"}));
app.get("/api/csrf",(req,res)=>{if(!req.session.csrfToken)req.session.csrfToken=crypto.randomBytes(32).toString("hex");res.json({csrfToken:req.session.csrfToken});});
app.get("/api/auth/me",(req,res)=>res.json({user:sessionUser(req)}));
app.post("/api/auth/register",authLimiter,requireCsrf,async(req,res,next)=>{
 try{
  const email=normaliseEmail(req.body?.email),password=String(req.body?.password||""),name=String(req.body?.name||"").trim().slice(0,80);
  if(!validEmail(email))return res.status(400).json({error:"Enter a valid email address."});
  if(!name)return res.status(400).json({error:"Enter your name."});
  if(password.length<10||password.length>128)return res.status(400).json({error:"Password must be 10–128 characters long."});
  if(/^(.)\1+$/.test(password))return res.status(400).json({error:"Choose a stronger password."});
  const passwordHash=await bcrypt.hash(password,12);
  const result=await pool.query("INSERT INTO piye_users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name",[email,passwordHash,name]);
  await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
  req.session.user={id:String(result.rows[0].id),email:result.rows[0].email,name:result.rows[0].display_name};req.session.csrfToken=crypto.randomBytes(32).toString("hex");
  req.session.save(err=>{if(err)return next(err);res.status(201).json({user:sessionUser(req),csrfToken:req.session.csrfToken});});
 }catch(err){if(err.code==="23505")return res.status(409).json({error:"An account with that email already exists."});next(err);}
});
app.post("/api/auth/login",authLimiter,requireCsrf,async(req,res,next)=>{
 try{
  const email=normaliseEmail(req.body?.email),password=String(req.body?.password||"");
  if(!validEmail(email)||!password)return res.status(400).json({error:"Enter your email and password."});
  const result=await pool.query("SELECT id,email,password_hash,display_name FROM piye_users WHERE email=$1",[email]);
  const user=result.rows[0];
  const ok=user ? await bcrypt.compare(password,user.password_hash) : false;
  if(!user||!ok)return res.status(401).json({error:"Email or password is incorrect."});
  await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
  req.session.user={id:String(user.id),email:user.email,name:user.display_name||''};req.session.csrfToken=crypto.randomBytes(32).toString("hex");
  req.session.save(err=>{if(err)return next(err);res.json({user:sessionUser(req),csrfToken:req.session.csrfToken});});
 }catch(err){next(err);}
});
app.post("/api/auth/logout",requireCsrf,async(req,res,next)=>{req.session.destroy(err=>{if(err)return next(err);res.clearCookie("piye.sid",{httpOnly:true,secure:isProduction,sameSite:isProduction?"none":"lax",path:"/"});res.json({ok:true});});});
app.get("/api/progress",requireAuth,async(req,res,next)=>{try{const result=await pool.query("SELECT progress,updated_at FROM piye_progress WHERE user_id=$1",[req.session.user.id]);res.json({progress:result.rows[0]?.progress||{},updatedAt:result.rows[0]?.updated_at||null});}catch(err){next(err);}});
app.put("/api/progress",requireCsrf,requireAuth,async(req,res,next)=>{
 try{
  const body=req.body||{};
  const completed=Array.isArray(body.completed)?body.completed.filter(x=>typeof x==="string"&&x.length<=40).slice(0,8000):[];
  const historyRead=Array.isArray(body.historyRead)?body.historyRead.filter(x=>typeof x==="string"&&x.length<=60).slice(0,100):[];
  const languageProgress=body.languageProgress&&typeof body.languageProgress==="object"&&!Array.isArray(body.languageProgress)?Object.fromEntries(Object.entries(body.languageProgress).filter(([k,v])=>k.length<80&&typeof v==="boolean").slice(0,500)):{};
  const learnerName=String(body.learnerName||"").trim().slice(0,100);
  const writingDraft=body.writingDraft&&typeof body.writingDraft==="object"?{prompt:String(body.writingDraft.prompt||"").slice(0,200),text:String(body.writingDraft.text||"").slice(0,20000),savedAt:String(body.writingDraft.savedAt||"").slice(0,50)}:null;
  const progress={completed:[...new Set(completed)],historyRead:[...new Set(historyRead)],languageProgress,learnerName,writingDraft};
  const result=await pool.query(`INSERT INTO piye_progress(user_id,progress,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(user_id) DO UPDATE SET progress=EXCLUDED.progress,updated_at=NOW() RETURNING progress,updated_at`,[req.session.user.id,JSON.stringify(progress)]);
  res.json({progress:result.rows[0].progress,updatedAt:result.rows[0].updated_at});
 }catch(err){next(err);}
});
app.get("/api/saved-words",requireAuth,async(req,res,next)=>{try{const r=await pool.query("SELECT word,created_at FROM piye_saved_words WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500",[req.session.user.id]);res.json({words:r.rows});}catch(err){next(err);}});
app.post("/api/saved-words",requireCsrf,requireAuth,async(req,res,next)=>{try{const word=String(req.body?.word||"").trim();if(!word||word.length>120)return res.status(400).json({error:"Word must be between 1 and 120 characters."});await pool.query("INSERT INTO piye_saved_words(user_id,word) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.session.user.id,word]);res.status(201).json({ok:true,word});}catch(err){next(err);}});
app.delete("/api/saved-words",requireCsrf,requireAuth,async(req,res,next)=>{try{const word=String(req.body?.word||"").trim();await pool.query("DELETE FROM piye_saved_words WHERE user_id=$1 AND word=$2",[req.session.user.id,word]);res.json({ok:true});}catch(err){next(err);}});
app.use((err,req,res,next)=>{console.error("PIYE API error:",err.message);if(res.headersSent)return next(err);res.status(500).json({error:"The server could not complete that request. Please try again."});});
initialise().then(()=>app.listen(port,"0.0.0.0",()=>console.log(`PIYE API listening on port ${port}`))).catch(err=>{console.error("Database initialisation failed:",err);process.exit(1);});
