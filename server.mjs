import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb, allAccounts, getAccount, getBrand, getLink, getPayment, withWrite } from './lib/db.mjs';
import { equalSecret, sign, newSession, validSession, parseRupees, rupees, isValidVpa, upiUri, clean } from './lib/security.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = {'/admin':'admin.html','/':'admin.html','/public/admin.js':'admin.js','/public/admin.css':'admin.css','/public/pay.css':'pay.css','/public/pay.js':'pay.js','/public/pay.html':'pay.html'};
const MIME = {'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'};
const attempts = new Map();
const badLogins = new Map();
const now = () => new Date().toISOString();

function json(res, status, data, headers={}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function fail(res,status,message) {json(res,status,{error:message});}
function cookieValue(req,key) {
  const match = (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='));
  return match ? match.slice(key.length+1) : '';
}
function originAllowed(req) {
  const origin=req.headers.origin;
  if (!origin) return true; // nonbrowser API callers still require Bearer/settlement HMAC
  try {
    const url = new URL(origin);
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    return url.host === req.headers.host && (url.protocol === proto || url.protocol === 'https:');
  } catch { return false; }
}
async function readBody(req,max=12*1024) {
  const chunks=[]; let size=0;
  for await(const chunk of req) {
    size+=chunk.length;
    if(size>max) throw Object.assign(new Error('Request body is too large'),{status:413});
    chunks.push(chunk);
  }
  const raw=Buffer.concat(chunks).toString('utf8');
  let value;
  try {value = JSON.parse(raw || '{}');} catch {throw new Error('Invalid JSON body');}
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('JSON body must be an object');
  return {value,raw};
}
function publicLink(link,base) {
  return {id:link.id,type:link.type,amount:link.amount_paise==null?null:rupees(link.amount_paise),
    title:link.title,customerName:link.customer_name,customerPhone:link.customer_phone,
    enabled:!!link.enabled,createdAt:link.created_at,expiresAt:link.expires_at,
    url:`${base}/pay/${link.id}`,accountId:link.account_id,externalId:link.external_id};
}
function publicPayment(p) {
  return {id:p.id, linkId:p.link_id, amount:rupees(p.amount_paise),status:p.status, createdAt:p.created_at,updatedAt:p.updated_at,
    utr:p.status==='PAID'?p.utr:null, verification:p.status==='PAID'?p.verification:null};
}
function verifyAccount(db,id) {
  const a=id?getAccount(db,id):db.prepare('SELECT * FROM accounts WHERE active=1 ORDER BY is_default DESC, created_at LIMIT 1').get();
  if(!a || !a.active) throw new Error('Select an active receiving UPI account');
  return a;
}
function makeLink(db,body) {
  const type=body.type === 'OPEN' ? 'OPEN' : body.type === 'FIXED' ? 'FIXED' : null;
  if(!type) throw new Error('Choose FIXED or OPEN link type');
  const acc=verifyAccount(db,body.accountId);
  const title=clean(body.title,100);
  if(!title) throw new Error('Payment title is required');
  const amount=type==='FIXED'?parseRupees(body.amount):null;
  const external=clean(body.externalId,80)||null;
  if(external && !/^[a-zA-Z0-9_-]{3,80}$/.test(external)) throw new Error('Invalid externalId');
  if(external && db.prepare('SELECT id FROM links WHERE external_id=?').get(external)) throw Object.assign(new Error('externalId already exists'),{status:409});
  const expires=body.expiresAt?new Date(body.expiresAt):null;
  if(expires && (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())) throw new Error('Invalid future expiration date');
  const link={id:randomUUID(),type,account_id:acc.id,amount_paise:amount,title,customer_name:clean(body.customerName,80),customer_phone:clean(body.customerPhone,20),external_id:external,enabled:1,created_at:now(),expires_at:expires?.toISOString()||null};
  db.prepare(`INSERT INTO links(id,type,account_id,amount_paise,title,customer_name,customer_phone,external_id,enabled,created_at,expires_at)
  VALUES(@id,@type,@account_id,@amount_paise,@title,@customer_name,@customer_phone,@external_id,@enabled,@created_at,@expires_at)`).run(link);
  return link;
}
function rate(map,key,max,windowMs) {
  const t=Date.now();const old=map.get(key)||[];
  const current=old.filter(x=>t-x<windowMs);
  current.push(t);map.set(key,current);
  if(map.size>5000) for (const [k,v] of map) if(v[v.length-1] < t-windowMs) map.delete(k);
  return current.length <= max;
}
function recordReconcile(db,paymentId,body,actor) {
  return withWrite(db,()=>{
    const p=getPayment(db,paymentId);
    if(!p) throw Object.assign(new Error('Payment not found'),{status:404});
    if(p.status==='PAID') throw Object.assign(new Error('Payment already paid'),{status:409});
    if(p.status==='REJECTED') throw Object.assign(new Error('Rejected payment cannot be confirmed'),{status:409});
    const outcome=body.action;
    if(!['PAID','REJECTED'].includes(outcome)) throw new Error('Invalid action');
    let utr=null;
    if(outcome==='PAID') {
      if(body.confirmedBank !== true) throw new Error('Confirm that the bank has independently verified this credit');
      utr=clean(body.utr,32);
      if(!/^[A-Za-z0-9-]{6,32}$/.test(utr)) throw new Error('Enter the real bank UTR/reference (6–32 characters)');
      const existing=db.prepare("SELECT id FROM payments WHERE utr=? AND account_id=? AND status='PAID'").get(utr,p.account_id);
      if(existing) throw Object.assign(new Error('This bank reference was already reconciled'),{status:409});
    }
    const t=now();
    db.prepare('UPDATE payments SET status=?, utr=?,verification=?,updated_at=? WHERE id=?').run(outcome,utr,outcome==='PAID'?actor:null,t,p.id);
    db.prepare('INSERT INTO audit(payment_id,action,details,created_at) VALUES(?,?,?,?)').run(p.id,`RECONCILE_${outcome}`,JSON.stringify({actor,utr}),t);
    return getPayment(db,p.id);
  });
}
function baseUrl(req,options) {
  const configured=(options.publicBaseUrl||'').replace(/\/$/,'');
  if(configured) return configured;
  const host=req.headers.host;
  return `${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${host}`;
}

export function createGateway({db=openDb(process.env.DB_PATH || path.join(root,'data','gateway.sqlite')),adminPassword=process.env.ADMIN_PASSWORD,sessionSecret=process.env.SESSION_SECRET,apiKey=process.env.API_KEY,settlementSecret=process.env.SETTLEMENT_SECRET,publicBaseUrl=process.env.PUBLIC_BASE_URL||''}={}) {
  if(!adminPassword || !sessionSecret || !apiKey || sessionSecret.length<24 || apiKey.length<24) throw new Error('Set ADMIN_PASSWORD, SESSION_SECRET (24+ chars), and API_KEY (24+ chars)');
  const config={publicBaseUrl};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let u;
    try {u=new URL(req.url,'http://localhost');} catch {fail(res,400,'Invalid URL');return;}
    const p=u.pathname,m=req.method, base=baseUrl(req,config);
    const adminAuth=validSession(cookieValue(req,'gateway_sid'),sessionSecret);
    const apiAuth=equalSecret((req.headers.authorization||'').replace(/^Bearer\s+/i,''),apiKey);
    const privileged=adminAuth||apiAuth;
    const clientIp=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0];
    try {
      if(m==='GET' && p==='/health') {json(res,200,{status:'ok'});return;}
      if(m==='GET' && ASSETS[p]) {
        if(p==='/'||p==='/admin') {
          // dashboard HTML is public but privileged JSON data never is
        }
        const file=path.join(root,'public',ASSETS[p]);
        const content=await fs.readFile(file);
        res.writeHead(200,{'Content-Type':MIME[path.extname(file)],'Cache-Control':'no-store'});res.end(content);return;
      }
      if(m==='GET' && p==='/public/logo') {
        const logo=db.prepare("SELECT value FROM settings WHERE key='uploaded_logo'").get();
        if(!logo) {fail(res,404,'Logo not configured');return;}
        const data=JSON.parse(logo.value);
        res.writeHead(200,{'Content-Type':data.mime,'Cache-Control':'public, max-age=600','X-Content-Type-Options':'nosniff'});
        res.end(Buffer.from(data.base64,'base64'));return;
      }
      if(m==='GET' && /^\/pay\/[a-f0-9-]{36}$/.test(p)) {
        const link=getLink(db,p.split('/')[2]);
        if(!link||!link.enabled||(link.expires_at && Date.now()>Date.parse(link.expires_at))) {fail(res,404,'Payment link unavailable');return;}
        const html=await fs.readFile(path.join(root,'public/pay.html'));
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
      }
      if(m==='POST' && p==='/api/login') {
        if(!originAllowed(req)) {fail(res,403,'Invalid request origin');return;}
        if(!rate(badLogins,clientIp,8,15*60*1000)) {fail(res,429,'Too many login attempts');return;}
        const {value}=await readBody(req);
        if(!equalSecret(value.password,adminPassword)) {fail(res,401,'Incorrect password');return;}
        badLogins.delete(clientIp);
        const secure = publicBaseUrl.startsWith('https://') || req.headers['x-forwarded-proto']==='https';
        json(res,200,{ok:true},{'Set-Cookie':`gateway_sid=${newSession(sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure?'; Secure':''}`});return;
      }
      if(m==='POST'&&p==='/api/logout') {
        if(!originAllowed(req)) {fail(res,403,'Invalid request origin');return;}
        json(res,200,{ok:true},{'Set-Cookie':'gateway_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return;
      }
      if(m==='GET'&&p==='/api/admin/me') {json(res,200,{authenticated:adminAuth});return;}
      if(m==='GET'&&p==='/api/public/brand') {const brand=getBrand(db);json(res,200,{...brand});return;}
      if(m==='GET'&&/^\/api\/public\/links\/[a-f0-9-]{36}$/.test(p)) {
        const link=getLink(db,p.split('/').at(-1));
        if(!link||!link.enabled || (link.expires_at&&Date.now()>Date.parse(link.expires_at))) {fail(res,404,'Payment link unavailable');return;}
        const a=getAccount(db,link.account_id);
        json(res,200,{...publicLink(link,base),payeeName:a.payee_name});return;
      }
      if(m==='POST'&&/^\/api\/public\/links\/[a-f0-9-]{36}\/attempts$/.test(p)) {
        if(!originAllowed(req)) {fail(res,403,'Invalid request origin');return;}
        if(!rate(attempts,clientIp,25,60*1000)) {fail(res,429,'Please retry shortly');return;}
        const linkId=p.split('/')[4]; const link=getLink(db,linkId);
        if(!link||!link.enabled || (link.expires_at&&Date.now()>Date.parse(link.expires_at))) {fail(res,404,'Payment link unavailable');return;}
        const account=verifyAccount(db,link.account_id);
        const {value}=await readBody(req);
        const amount=link.type==='OPEN'?parseRupees(value.amount):link.amount_paise;
        const t=now();const payment={id:randomUUID(),link_id:link.id,account_id:account.id,vpa:account.vpa,payee_name:account.payee_name,
          amount_paise:amount,status:'PENDING',utr:null,verification:null,created_at:t,updated_at:t,customer_note:clean(value.customerNote,120)};
        db.prepare(`INSERT INTO payments(id,link_id,account_id,vpa,payee_name,amount_paise,status,utr,verification,created_at,updated_at,customer_note)
          VALUES(@id,@link_id,@account_id,@vpa,@payee_name,@amount_paise,@status,@utr,@verification,@created_at,@updated_at,@customer_note)`).run(payment);
        json(res,201,{...publicPayment(payment),checkoutUrl:`${base}/pay/${link.id}?attempt=${payment.id}`});return;
      }
      if(m==='GET'&&/^\/api\/public\/attempts\/[a-f0-9-]{36}$/.test(p)) {
        const payment=getPayment(db,p.split('/').at(-1));
        if(!payment) {fail(res,404,'Payment not found');return;}
        const link=getLink(db,payment.link_id);
        const uri=upiUri({vpa:payment.vpa,payee_name:payment.payee_name},payment.amount_paise,link.title);
        json(res,200,{...publicPayment(payment),payeeName:payment.payee_name,upiId:payment.vpa,upiUri:uri,qrUrl:`${base}/qr/payments/${payment.id}.svg`});return;
      }
      if(m==='POST'&&/^\/api\/public\/attempts\/[a-f0-9-]{36}\/report$/.test(p)) {
        if(!originAllowed(req)) {fail(res,403,'Invalid request origin');return;}
        if(!rate(attempts,clientIp,25,60*1000)) {fail(res,429,'Please retry shortly');return;}
        const id=p.split('/')[4]; const payment=getPayment(db,id);
        if(!payment) {fail(res,404,'Payment not found');return;}
        if(payment.status==='PENDING') db.prepare("UPDATE payments SET status='CUSTOMER_REPORTED',updated_at=? WHERE id=?").run(now(),id);
        json(res,200,{...publicPayment(getPayment(db,id)),message:'Reported to merchant. Not yet bank-verified.'});return;
      }
      if(m==='GET'&&/^\/qr\/(static|payments|links)\/[a-f0-9-]{36}\.svg$/.test(p)) {
        const [,type,id]=p.match(/^\/qr\/(static|payments|links)\/([a-f0-9-]{36})\.svg$/);
        let uri;
        if(type==='static') {
          const a=getAccount(db,id); if(!a||!a.active) {fail(res,404,'UPI account unavailable');return;}
          uri=upiUri(a);
        } else if(type==='links') {
          const l=getLink(db,id);
          if(!l || l.type!=='FIXED' || !l.enabled || (l.expires_at&&Date.now()>Date.parse(l.expires_at))) {fail(res,404,'Fixed-amount QR unavailable');return;}
          const a=verifyAccount(db,l.account_id);
          // Merchant-generated QR has no individual payment attempt. Reconcile manually.
          uri=upiUri(a,l.amount_paise,l.title);
        } else {
          const pay=getPayment(db,id);if(!pay) {fail(res,404,'Payment unavailable');return;}
          uri=upiUri({vpa:pay.vpa,payee_name:pay.payee_name},pay.amount_paise,getLink(db,pay.link_id).title);
        }
        const {default:Qr}=await import('qrcode');
        const svg=await Qr.toString(uri,{type:'svg',width:320,margin:2,errorCorrectionLevel:'M'});
        res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store'});res.end(svg);return;
      }
      if(p.startsWith('/api/admin/')||p.startsWith('/api/v1/')) {
        if(!privileged && !(p==='/api/v1/settlements/confirm'&&m==='POST')) {fail(res,401,'Admin session or bearer API key required');return;}
        if(adminAuth&&!apiAuth&&m!=='GET'&&!originAllowed(req)) {fail(res,403,'Invalid request origin');return;}
      }
      if(m==='GET'&&p==='/api/admin/overview') {
        const amounts=db.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN status='PAID' THEN 1 END) as paidCount, COALESCE(SUM(CASE WHEN status='PAID' THEN amount_paise ELSE 0 END),0) as paidPaise FROM payments").get();
        json(res,200,{...amounts,paidAmount:rupees(amounts.paidPaise),accounts:db.prepare('SELECT COUNT(*) as n FROM accounts').get().n,links:db.prepare('SELECT COUNT(*) as n FROM links').get().n});return;
      }
      if(m==='GET'&&p==='/api/admin/branding') {json(res,200,getBrand(db));return;}
      if(m==='POST'&&p==='/api/admin/logo') {
        const {value}=await readBody(req,450000);
        const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value.dataUrl||'');
        if(!m) throw new Error('Choose a PNG, JPEG or WebP image');
        const raw=Buffer.from(m[2],'base64');
        if(raw.length<12||raw.length>250000) throw new Error('Logo must be 250 KB or smaller');
        const actual=raw.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':
          (raw[0]===0xff&&raw[1]===0xd8&&raw[2]===0xff)?'image/jpeg':
          (raw.toString('ascii',0,4)==='RIFF'&&raw.toString('ascii',8,12)==='WEBP')?'image/webp':null;
        if(actual!==m[1]) throw new Error('Logo file type does not match contents');
        db.prepare("INSERT INTO settings(key,value) VALUES('uploaded_logo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify({mime:actual,base64:raw.toString('base64')}));
        json(res,200,{logoUrl:'/public/logo'});return;
      }
      if(m==='PUT'&&p==='/api/admin/branding') {
        const {value}=await readBody(req);
        const theme=['indigo','emerald','sunset'].includes(value.theme)?value.theme:'indigo';
        let logoUrl=clean(value.logoUrl,500);
        if(logoUrl && logoUrl!=='/public/logo') {const l=new URL(logoUrl);if(l.protocol!=='https:'||l.username||l.password) throw new Error('Logo must be an uploaded image or public HTTPS image URL');}
        const brand={title:clean(value.title,90)||'Payment Gateway', businessName:clean(value.businessName,90)||'Business',logoUrl,theme};
        db.prepare("UPDATE settings SET value=? WHERE key='branding'").run(JSON.stringify(brand));
        json(res,200,brand);return;
      }
      if(m==='GET'&&(p==='/api/admin/accounts'||p==='/api/v1/accounts')) {json(res,200,{accounts:allAccounts(db)});return;}
      if(m==='POST'&&p==='/api/admin/accounts') {
        const {value}=await readBody(req);
        const vpa=clean(value.vpa,320), payee=clean(value.payeeName,100),label=clean(value.label,80);
        if(!isValidVpa(vpa)||!payee||!label) throw new Error('Provide a valid UPI ID, account label and payee name');
        const id=randomUUID(),t=now();
        withWrite(db,()=>{
          const first=db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n===0;
          db.prepare('INSERT INTO accounts(id,label,vpa,payee_name,active,is_default,created_at) VALUES(?,?,?,?,1,?,?)').run(id,label,vpa,payee,first?1:0,t);
        });
        json(res,201,{account:getAccount(db,id)});return;
      }
      if(m==='PATCH'&&/^\/api\/admin\/accounts\/[a-f0-9-]{36}$/.test(p)) {
        const id=p.split('/').at(-1);const prev=getAccount(db,id);
        if(!prev) {fail(res,404,'Account not found');return;}
        const {value}=await readBody(req);
        withWrite(db,()=>{
          if(value.default===true) {
            db.prepare('UPDATE accounts SET is_default=0').run();
            db.prepare('UPDATE accounts SET is_default=1,active=1 WHERE id=?').run(id);
          }
          if(typeof value.active==='boolean') {
            if(value.active===false&&prev.is_default) throw new Error('Set a different default account first');
            db.prepare('UPDATE accounts SET active=? WHERE id=?').run(value.active?1:0,id);
          }
        });
        json(res,200,{account:getAccount(db,id)});return;
      }
      if(m==='DELETE'&&/^\/api\/admin\/accounts\/[a-f0-9-]{36}$/.test(p)) {
        const id=p.split('/').at(-1);
        const account=getAccount(db,id);
        if(!account) {fail(res,404,'Account not found');return;}
        if(account.is_default) throw new Error('Choose a new default account first');
        if(db.prepare('SELECT 1 FROM links WHERE account_id=? LIMIT 1').get(id)) throw new Error('Account has payment links; deactivate it rather than delete it');
        db.prepare('DELETE FROM accounts WHERE id=?').run(id);json(res,200,{ok:true});return;
      }
      if(m==='GET'&&(p==='/api/admin/links'||p==='/api/v1/links')) {
        const links=db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT 150').all().map(x=>publicLink(x,base));
        json(res,200,{links});return;
      }
      if(m==='POST'&&(p==='/api/admin/links'||p==='/api/v1/links')) {
        const {value}=await readBody(req);
        const link=makeLink(db,value);json(res,201,publicLink(link,base));return;
      }
      if(m==='PATCH'&&/^\/api\/admin\/links\/[a-f0-9-]{36}$/.test(p)) {
        const id=p.split('/').at(-1);const link=getLink(db,id);if(!link) {fail(res,404,'Link not found');return;}
        const {value}=await readBody(req);if(typeof value.enabled!=='boolean') throw new Error('enabled must be a boolean');
        db.prepare('UPDATE links SET enabled=? WHERE id=?').run(value.enabled?1:0,id);
        json(res,200,publicLink(getLink(db,id),base));return;
      }
      if(m==='GET'&&(p==='/api/admin/payments'||p==='/api/v1/payments')) {
        const status=clean(u.searchParams.get('status'),40);
        const rows=status?db.prepare('SELECT * FROM payments WHERE status=? ORDER BY created_at DESC LIMIT 200').all(status):db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 200').all();
        json(res,200,{payments:rows.map(p=>({...publicPayment(p),utr:p.utr,verification:p.verification,upiId:p.vpa,customerNote:p.customer_note,linkTitle:getLink(db,p.link_id)?.title||'',customerName:getLink(db,p.link_id)?.customer_name||'',customerPhone:getLink(db,p.link_id)?.customer_phone||''}))});return;
      }
      if(m==='GET'&&/^\/api\/v1\/payments\/[a-f0-9-]{36}$/.test(p)) {
        const payment=getPayment(db,p.split('/').at(-1));if(!payment) {fail(res,404,'Payment not found');return;}
        json(res,200,{...publicPayment(payment),utr:payment.utr,verification:payment.verification});return;
      }
      if(m==='POST'&&/^\/api\/admin\/payments\/[a-f0-9-]{36}\/reconcile$/.test(p)) {
        const paymentId=p.split('/')[4];const {value}=await readBody(req);
        const record=recordReconcile(db,paymentId,value,'MANUAL_BANK_CHECK');
        json(res,200,publicPayment(record));return;
      }
      if(m==='POST'&&p==='/api/v1/settlements/confirm') {
        // Requires a trusted BANK/PSP verification provider, NOT a customer app callback.
        if(!settlementSecret||settlementSecret.length<24) {fail(res,503,'No trusted settlement provider configured');return;}
        const ts=String(req.headers['x-settlement-timestamp']||'');
        if(!/^\d{13}$/.test(ts)||Math.abs(Date.now()-Number(ts))>5*60*1000) {fail(res,401,'Expired signature timestamp');return;}
        const {value,raw}=await readBody(req);
        if(!equalSecret(req.headers['x-settlement-signature'],`sha256=${sign(`${ts}.${raw}`,settlementSecret)}`)) {fail(res,401,'Invalid settlement signature');return;}
        if(!/^[a-zA-Z0-9_-]{8,80}$/.test(String(value.eventId||''))) throw new Error('eventId required');
        if(!value.bankVerified) throw new Error('Bank-verified settlement evidence required');
        const pmt=getPayment(db,value.paymentId);
        if(!pmt) {fail(res,404,'Payment not found');return;}
        const amount=parseRupees(value.amount);
        if(amount!==pmt.amount_paise||!equalSecret(value.upiId,pmt.vpa)) {fail(res,409,'Amount or receiving UPI ID mismatch');return;}
        const old=db.prepare('SELECT id FROM observer_events WHERE id=?').get(value.eventId);
        if(old) {json(res,200,{ok:true,duplicate:true});return;}
        const result=withWrite(db,()=>{
          db.prepare('INSERT INTO observer_events(id,payment_id,amount_paise,utr,received_at) VALUES(?,?,?,?,?)').run(value.eventId,pmt.id,amount,clean(value.utr,32),now());
          if(pmt.status==='PAID' && pmt.utr===value.utr) return pmt;
          return recordReconcileWithoutTransaction(db,pmt.id,{action:'PAID',confirmedBank:true,utr:value.utr},'TRUSTED_SETTLEMENT_CALLBACK');
        });
        json(res,200,{ok:true,payment:publicPayment(result)});return;
      }
      if(p.startsWith('/api/')) {fail(res,404,'API route not found');return;}
      fail(res,404,'Page not found');
    } catch(e) {
      let status=e.status || 400;
      if(/UNIQUE constraint failed/.test(e.message)) status=409;
      if(e.message?.includes('Cannot find package')) {status=503;}
      if(status>=500) console.error('Server error',e);
      fail(res,status,status>=500?'Server error':e.message||'Invalid request');
    }
  });
  return {server,db};
}

function recordReconcileWithoutTransaction(db,id,body,actor){
  // Settlement callback runs inside its own transaction; mirror the manual checks without nesting.
  const p=getPayment(db,id);
  if(!p||p.status==='REJECTED') throw Object.assign(new Error('Invalid settlement state'),{status:409});
  const utr=clean(body.utr,32);
  if(!/^[A-Za-z0-9-]{6,32}$/.test(utr)) throw new Error('Invalid bank UTR');
  const other=db.prepare("SELECT id FROM payments WHERE utr=? AND account_id=? AND status='PAID' AND id!=?").get(utr,p.account_id,id);
  if(other) throw Object.assign(new Error('Bank reference already used'),{status:409});
  const t=now();
  db.prepare("UPDATE payments SET status='PAID', utr=?, verification=?, updated_at=? WHERE id=?").run(utr,actor,t,id);
  db.prepare('INSERT INTO audit(payment_id,action,details,created_at) VALUES(?,?,?,?)').run(id,'RECONCILE_PAID',JSON.stringify({actor,utr}),t);
  return getPayment(db,id);
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(typeof process.loadEnvFile==='function') {
    try {process.loadEnvFile();} catch {} // EasyPanel passes variables directly
  }
  const {server}=createGateway();
  const port=Number(process.env.PORT||3000);
  server.listen(port,'0.0.0.0',()=>console.log(`UPI Link Gateway ready on port ${port}`));
}
