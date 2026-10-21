import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../server.mjs';
import { openDb } from '../lib/db.mjs';
import { sign, parseRupees, upiUri } from '../lib/security.mjs';

const secret='test-session-secret-minimum-length-12345';
const apiKey='test-api-key-minimum-length-123456789';
const settle='test-bank-settlement-secret-123456789';
async function start(){
  const db=openDb(':memory:');
  const {server}=createGateway({db,adminPassword:'test-admin-password',sessionSecret:secret,apiKey,settlementSecret:settle});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {db,server,base:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
function agent(base,cookie='',bearer=''){
  return async(path,method='GET',body,extra={})=>{
    const response=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
    let data=await response.json().catch(()=>null);
    return {status:response.status,data,headers:response.headers};
  };
}
test('validate amounts and UPI URIs',()=>{
  assert.equal(parseRupees('100.50'),10050);
  assert.equal(parseRupees('1'),100);
  assert.throws(()=>parseRupees('0.20'));
  assert.throws(()=>parseRupees('100.234'));
  const uri=upiUri({vpa:'test@bank',payee_name:'Test Store'},10050,'Order');
  assert.match(uri,/am=100.50/);assert.match(uri,/pa=test%40bank/);
  const query=new URL(uri).searchParams;
  assert.equal(query.get('pn'),'Test Store');
  assert.equal(query.get('cu'),'INR');
  assert.equal(query.get('tn'),'Order');
  assert.equal(query.has('tr'),false,'Personal account UPI must not invent merchant references');
  const staticUri=new URL(upiUri({vpa:'test@bank',payee_name:'Test Store'}));
  assert.equal(staticUri.searchParams.has('tr'),false);
  assert.equal(staticUri.searchParams.has('am'),false);
});
test('full merchant and public checkout workflow',async()=>{
  const s=await start();
  try{
    const anon=agent(s.base);
    let r=await anon('/api/admin/accounts');assert.equal(r.status,401);
    r=await anon('/api/login','POST',{password:'incorrect'});assert.equal(r.status,401);
    r=await anon('/api/login','POST',{password:'test-admin-password'});
    assert.equal(r.status,200); const cookie=r.headers.get('set-cookie').split(';')[0];
    const admin=agent(s.base,cookie),api=agent(s.base,'',apiKey);
    r=await admin('/api/admin/accounts','POST',{vpa:'one@upi',label:'Main',payeeName:'Main Merchant'});
    assert.equal(r.status,201);const aid=r.data.account.id;
    r=await admin('/api/admin/accounts','POST',{vpa:'two@upi',label:'Second',payeeName:'Other Merchant'});
    assert.equal(r.status,201);const bid=r.data.account.id;
    r=await api('/api/v1/accounts');assert.equal(r.data.accounts.length,2);
    r=await admin('/api/admin/accounts/'+bid,'PATCH',{default:true});assert.equal(r.status,200);
    r=await admin('/api/admin/branding','PUT',{title:'My Gateway',businessName:'S.A Traders',logoUrl:'https://example.com/logo.png',theme:'sunset'});
    assert.equal(r.status,200);
    r=await api('/api/v1/links','POST',{type:'FIXED',accountId:aid,title:'Invoice 12',amount:'259.50',customerName:'Vijay',externalId:'invoice12'});
    assert.equal(r.status,201);const fixed=r.data;
    r=await anon(`/api/public/links/${fixed.id}`);assert.equal(r.status,200);assert.equal(r.data.amount,'259.50');
    r=await anon(`/api/public/links/${fixed.id}/attempts`,'POST',{});
    assert.equal(r.status,201);const payId=r.data.id;
    r=await anon(`/api/public/attempts/${payId}`);
    assert.equal(r.status,200); assert.match(r.data.upiUri,/pa=one%40upi/); assert.match(r.data.upiUri,/am=259.50/);
    assert.equal(new URL(r.data.upiUri).searchParams.has('tr'),false);
    r=await anon(`/api/public/attempts/${payId}/report`,'POST',{});
    assert.equal(r.data.status,'CUSTOMER_REPORTED');
    r=await anon(`/api/public/attempts/${payId}`);assert.notEqual(r.data.status,'PAID');
    r=await admin(`/api/admin/payments/${payId}/reconcile`,'POST',{action:'PAID',utr:'123456789011',confirmedBank:false});assert.equal(r.status,400);
    r=await admin(`/api/admin/payments/${payId}/reconcile`,'POST',{action:'PAID',utr:'123456789011',confirmedBank:true});assert.equal(r.status,200);assert.equal(r.data.status,'PAID');
    r=await api(`/api/v1/payments/${payId}`);assert.equal(r.data.status,'PAID');assert.equal(r.data.utr,'123456789011');
    r=await admin('/api/admin/overview');assert.equal(r.data.paidCount,1);assert.equal(r.data.paidAmount,'259.50');
    r=await admin('/api/admin/links','POST',{type:'OPEN',title:'Donation',accountId:bid});assert.equal(r.status,201);const open=r.data;
    r=await anon(`/api/public/links/${open.id}/attempts`,'POST',{amount:'19.25'});assert.equal(r.status,201);
    const openId=r.data.id;
    r=await anon(`/api/public/attempts/${openId}`);assert.equal(r.data.amount,'19.25');assert.match(r.data.upiUri,/pa=two%40upi/);
    r=await admin(`/api/admin/links/${open.id}`,'PATCH',{enabled:false});assert.equal(r.status,200);
    r=await anon(`/api/public/links/${open.id}/attempts`,'POST',{amount:'90.00'});assert.equal(r.status,404);
    r=await admin(`/api/admin/accounts/${aid}`,'PATCH',{active:false});assert.equal(r.status,200);
    r=await anon(`/qr/static/${aid}.svg`);assert.equal(r.status,404);
    r=await anon('/api/logout','POST');assert.equal(r.status,200);
    r=await anon('/api/admin/me');assert.equal(r.data.authenticated,false);
  }finally{await s.close();}
});
test('trusted settlement requires HMAC and exact account and amount',async()=>{
  const s=await start();
  try{
    const api=agent(s.base,'',apiKey),pub=agent(s.base);
    let r=await api('/api/admin/accounts','POST',{vpa:'bankuser@upi',label:'Bank',payeeName:'Merchant'});
    const aid=r.data.account.id;
    r=await api('/api/v1/links','POST',{type:'FIXED',title:'Test',accountId:aid,amount:'20.00'});
    const id=r.data.id;
    r=await pub(`/api/public/links/${id}/attempts`,'POST',{});
    const payId=r.data.id;
    const url='/api/v1/settlements/confirm';
    const data={eventId:'event-confirmation-1',paymentId:payId,amount:'20.00',upiId:'bankuser@upi',utr:'UTR0123456',bankVerified:true};
    r=await pub(url,'POST',data);assert.equal(r.status,401);
    const timestamp=String(Date.now());
    const headers={'X-Settlement-Timestamp':timestamp,'X-Settlement-Signature':'sha256='+sign(`${timestamp}.${JSON.stringify(data)}`,settle)};
    r=await pub(url,'POST',data,headers);assert.equal(r.status,200);assert.equal(r.data.payment.status,'PAID');
    r=await pub(url,'POST',data,headers);assert.equal(r.status,200);assert.equal(r.data.duplicate,true);
    const returned=await api(`/api/v1/payments/${payId}`);assert.equal(returned.data.verification,'TRUSTED_SETTLEMENT_CALLBACK');
  }finally{await s.close();}
});

test('payment checkout stylesheet is served and hides inactive screens', async () => {
  const s = await start();
  try {
    const css = await fetch(s.base + '/public/pay.css');
    assert.equal(css.status, 200);
    assert.ok((css.headers.get('content-type') || '').includes('text/css'));
    const source = await css.text();
    assert.ok(source.includes('.hidden{display:none!important}'));
    assert.ok(source.includes('.app-grid{display:grid'));
    const page = await fetch(s.base + '/pay/00000000-0000-0000-0000-000000000000');
    assert.equal(page.status, 404);
  } finally { await s.close(); }
});
