'use strict';
const $=id=>document.getElementById(id);
const linkId=location.pathname.split('/')[2];
let link, attempt;
const packages={gpay:'com.google.android.apps.nbu.paisa.user',phonepe:'com.phonepe.app',paytm:'net.one97.paytm'};
async function api(url,method='GET',body) {
  const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.error||'Could not complete the request');
  return data;
}
function error(message){$('checkout-error').textContent=message;$('checkout-error').classList.remove('hidden');}
function money(n){return '₹'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});}
function isAndroid(){return /Android/i.test(navigator.userAgent)||navigator.userAgentData?.platform==='Android';}
function appLink(app,upiUri){
  // The server is authoritative for pa/pn/am/tr. Only swap the URI handler.
  if(!upiUri.startsWith('upi://pay?'))return '#';
  const query=upiUri.slice('upi://pay?'.length);
  if(!isAndroid()||app==='any')return upiUri;
  const pkg=packages[app];if(!pkg)return upiUri;
  const fallback=new URL(location.href);fallback.searchParams.set('fallback',app);
  return `intent://pay?${query}#Intent;scheme=upi;package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback.toString())};end`;
}
function present(p){
  attempt=p;
  $('start-screen').classList.add('hidden');$('pay-screen').classList.remove('hidden');
  $('pay-amount').textContent=money(p.amount);
  $('upi-id').textContent=`To: ${p.payeeName} · ${p.upiId}`;
  $('qr-image').src=p.qrUrl;
  for(const anchor of document.querySelectorAll('[data-app]')) anchor.href=appLink(anchor.dataset.app,p.upiUri);
  const status=$('status-box');
  status.className='payment-status';
  if(p.status==='PAID'){
    status.classList.add('paid');status.textContent='✓ Payment confirmed by merchant';$('report-pay').disabled=true;
    $('report-pay').textContent='Payment completed';
  } else if(p.status==='REJECTED') {
    status.textContent='Payment could not be verified. Contact the merchant.';$('report-pay').disabled=true;
  } else if(p.status==='CUSTOMER_REPORTED'){
    status.classList.add('reported');status.textContent='You reported payment — waiting for merchant verification';
    $('report-pay').disabled=true;$('report-pay').textContent='Verification requested';
  }else{status.textContent='Awaiting verified payment';}
}
async function refreshAttempt(){
  if(!attempt)return;
  try{const updated=await api('/api/public/attempts/'+attempt.id);present(updated);}catch{}
}
async function main(){
  try {
    const [b,l]=await Promise.all([api('/api/public/brand'),api('/api/public/links/'+linkId)]);
    link=l;
    document.body.dataset.theme=b.theme;
    $('business-name').textContent=b.businessName||l.payeeName;
    $('gateway-title').textContent=b.title||'Complete your payment';
    $('payment-description').textContent=l.title;
    document.title=`${b.businessName||'Merchant'} — UPI Payment`;
    if(b.logoUrl&&(b.logoUrl.startsWith('https://')||b.logoUrl==='/public/logo')){
      const img=document.createElement('img');img.src=b.logoUrl;img.alt='Business logo';img.referrerPolicy='no-referrer';
      const icon=document.querySelector('.brand-icon');icon.textContent='';icon.appendChild(img);
    }
    $('open-input').classList.toggle('hidden',l.type!=='OPEN');
    $('fixed-amount').classList.toggle('hidden',l.type==='OPEN');
    $('fixed-amount').textContent=money(l.amount||0);
    const prev=new URLSearchParams(location.search).get('attempt');
    if(prev&&/^[a-f0-9-]{36}$/.test(prev)) {
      const prior=await api('/api/public/attempts/'+prev);
      if(prior.linkId===linkId)present(prior);
    }
  }catch(e){error(e.message);$('begin-pay').disabled=true;}
}
$('begin-pay').addEventListener('click',async()=>{
  const button=$('begin-pay');button.disabled=true;
  try{
    const body={customerNote:$('customer-note').value};
    if(link.type==='OPEN')body.amount=$('amount').value;
    const created=await api('/api/public/links/'+linkId+'/attempts','POST',body);
    history.replaceState(null,'',`/pay/${linkId}?attempt=${created.id}`);
    present(await api('/api/public/attempts/'+created.id));
  }catch(e){error(e.message);}finally{button.disabled=false;}
});
$('report-pay').addEventListener('click',async()=>{
  if(!attempt)return;
  try{const p=await api('/api/public/attempts/'+attempt.id+'/report','POST',{});present({...attempt,...p});}
  catch(e){error(e.message);}
});
for(const a of document.querySelectorAll('[data-app]')) {
  a.addEventListener('click',e=>{
    if(!attempt||['PAID','REJECTED'].includes(attempt.status)){e.preventDefault();return;}
    if(!/Android|iPhone|iPad/i.test(navigator.userAgent)){
      e.preventDefault();$('app-hint').textContent='Open this payment link on your phone or scan the QR code with a UPI app.';
    }
    // A real anchor navigation inside a real click allows Chrome Android to hand off to apps.
    // No browser app launch event is interpreted as payment success.
  });
}
if(new URLSearchParams(location.search).has('fallback')) $('app-hint').textContent='The selected UPI app could not be opened. Try Other UPI or scan the QR.';
window.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAttempt();});
setInterval(()=>{if(attempt&&!['PAID','REJECTED'].includes(attempt.status)&&!document.hidden)refreshAttempt();},8000);
main();
