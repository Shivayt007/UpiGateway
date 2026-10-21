'use strict';
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const currency=n=>'₹'+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
let cache={accounts:[],links:[],payments:[],overview:{},branding:{}};
let activeTab='overview';
async function request(url,method='GET',data) {
  const r=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.error||`Request failed (${r.status})`);
  return body;
}
function flash(message,error=false){$('alert').textContent=message;$('alert').className=error?'error':'';window.scrollTo({top:0,behavior:'smooth'});}
function explain(err){flash(err.message||String(err),true);}
async function init(){
  const r=await request('/api/admin/me');
  $('login-shell').classList.toggle('hidden',r.authenticated);
  $('app-shell').classList.toggle('hidden',!r.authenticated);
  if(r.authenticated) await load();
}
async function load(){
  const [accounts,links,payments,branding,overview]=await Promise.all([
    request('/api/admin/accounts'),request('/api/admin/links'),request('/api/admin/payments'),request('/api/admin/branding'),request('/api/admin/overview')]);
  cache={accounts:accounts.accounts,links:links.links,payments:payments.payments,branding,overview};
  draw();
}
function draw(){
  $('stats').innerHTML=[['Total attempts',cache.overview.total,'▤'],['Confirmed receipts',cache.overview.paidCount,'✓'],['Verified value',currency(cache.overview.paidAmount),'₹'],['Active links',cache.links.filter(x=>x.enabled).length,'↗']]
    .map(([label,value,icon])=>`<div class="stat"><small>${label}</small><span class="decoration">${icon}</span><b>${esc(value)}</b></div>`).join('');
  $('link-count').textContent=`${cache.links.length} links`;
  $('account-count').textContent=`${cache.accounts.length} accounts`;
  $('link-account').innerHTML=cache.accounts.filter(a=>a.active).map(a=>`<option value="${esc(a.id)}">${esc(a.label)} (${esc(a.vpa)})</option>`).join('');
  drawAccounts();drawLinks();drawPayments();drawBrand();
  $('recent').innerHTML=cache.payments.slice(0,5).map(paymentRow).join('')||'<div class="empty">No payment attempts yet.</div>';
  $('account-summary').innerHTML=cache.accounts.map(a=>`<div class="data-row"><div><b>${esc(a.label)} ${a.is_default?'<span class="tag active">Default</span>':''}</b><small>${esc(a.vpa)}</small></div><span class="tag ${a.active?'active':''}">${a.active?'Active':'Inactive'}</span></div>`).join('')||'<div class="empty">Add a receiving UPI account to begin.</div>';
  const first=cache.links.find(l=>l.enabled);$('public-link').href=first?first.url:'#';$('public-link').style.display=first?'inline-flex':'none';
  $('api-example').textContent=`curl -X POST '${location.origin}/api/v1/links' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"type":"FIXED","title":"Order #1001","amount":"499.00","accountId":"ACCOUNT_ID"}'\n\n# Look up payment status:\ncurl -H 'Authorization: Bearer YOUR_API_KEY' \\\n  '${location.origin}/api/v1/payments/PAYMENT_ID'`;
}
function paymentRow(p){
  return `<div class="data-row"><div><b>${esc(p.linkTitle||'Payment')} <span class="tag ${esc(p.status)}">${esc(p.status.replaceAll('_',' '))}</span></b><small>${esc(p.customerName||p.id.slice(0,8))} · ${esc(new Date(p.createdAt).toLocaleString('en-IN'))}<br>${esc(p.upiId||'')}${p.utr?' · UTR '+esc(p.utr):''}</small></div><span class="money">${currency(p.amount)}</span></div>`;
}
function drawPayments(){
  const status=$('history-filter').value;
  const entries=cache.payments.filter(p=>!status||p.status===status);
  $('payment-list').innerHTML=entries.map(p=>`<div class="data-row"><div><b>${esc(p.linkTitle||'Payment')} <span class="tag ${esc(p.status)}">${esc(p.status.replaceAll('_',' '))}</span></b><small>${esc(p.customerName||'Guest')} ${p.customerPhone?'· '+esc(p.customerPhone):''} · ${esc(new Date(p.createdAt).toLocaleString('en-IN'))} · ${esc(p.upiId)}<br>${esc(p.id)}${p.utr?' · UTR '+esc(p.utr):''}</small></div><div class="row-actions"><span class="money">${currency(p.amount)}</span>${!['PAID','REJECTED'].includes(p.status)?`<button class="btn outline" data-verify="${esc(p.id)}">Bank verified ✓</button><button class="btn danger" data-reject="${esc(p.id)}">Reject</button>`:''}</div></div>`).join('')||'<div class="empty">No matching payment attempts.</div>';
}
function drawAccounts(){
  $('account-list').innerHTML=cache.accounts.map(a=>`<div class="data-row"><div><b>${esc(a.label)} ${a.is_default?'<span class="tag active">Default</span>':''} ${!a.active?'<span class="tag">Disabled</span>':''}</b><small>${esc(a.payee_name)} · ${esc(a.vpa)}</small></div><div class="row-actions">${a.active?`<a class="btn outline" href="/qr/static/${esc(a.id)}.svg" target="_blank" rel="noopener">View QR ↗</a>`:''}${!a.is_default?`<button class="btn outline" data-default="${esc(a.id)}">Make default</button><button class="btn outline" data-toggle="${esc(a.id)}" data-active="${a.active?'0':'1'}">${a.active?'Disable':'Enable'}</button>`:''}</div></div>`).join('')||'<div class="empty">No receiving UPI IDs configured.</div>';
}
function drawLinks(){
  $('link-list').innerHTML=cache.links.map(l=>`<div class="data-row"><div><b>${esc(l.title)} <span class="tag ${l.enabled?'active':''}">${l.enabled?'Live':'Disabled'}</span></b><small>${l.type==='OPEN'?'Open amount':currency(l.amount)} · ${esc(new Date(l.createdAt).toLocaleString('en-IN'))}<br>${esc(l.url)}</small></div><div class="row-actions"><button class="btn outline" data-copy="${esc(l.url)}">Copy</button><a class="btn outline" href="${esc(l.url)}" target="_blank" rel="noopener">Open ↗</a>${l.type==='FIXED'&&l.enabled?`<a class="btn outline" href="/qr/links/${esc(l.id)}.svg" target="_blank" rel="noopener">Amount QR ↗</a>`:''}<button class="btn ${l.enabled?'danger':'outline'}" data-link-toggle="${esc(l.id)}" data-enabled="${l.enabled?'0':'1'}">${l.enabled?'Disable':'Enable'}</button></div></div>`).join('')||'<div class="empty">Create your first payment link above.</div>';
}
function drawBrand(){
  for(const [key,value] of Object.entries(cache.branding)){
    const el=document.querySelector(`#brand-form [name="${key}"]`);
    if(el) el.value=value||'';
  }
}
function showTab(name){
  activeTab=name;
  document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===name));
  document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==`view-${name}`));
  $('crumb').textContent=name.toUpperCase();
  $('page-title').textContent=({overview:'Overview',links:'Payment links',accounts:'UPI accounts',payments:'Payment history',branding:'Appearance',developers:'Developer API'})[name];
  window.scrollTo({top:0,behavior:'smooth'});
}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();$('login-error').textContent='';
  try{await request('/api/login','POST',{password:$('password').value});$('password').value='';await init();}
  catch(err){$('login-error').textContent=err.message;}
});
$('logout').addEventListener('click',async()=>{await request('/api/logout','POST');window.location.href='/admin';});
$('refresh').addEventListener('click',async()=>{try{await load();flash('Dashboard refreshed.');}catch(err){explain(err);}});
$('history-filter').addEventListener('change',drawPayments);
$('link-type').addEventListener('change',()=>{const fixed=$('link-type').value==='FIXED';$('amount-field').classList.toggle('hidden',!fixed);document.querySelector('#amount-field input').required=fixed;});
$('account-form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const data=Object.fromEntries(new FormData(e.target));await request('/api/admin/accounts','POST',data);
    e.target.reset();await load();flash('UPI receiving account added.');
  }catch(err){explain(err);}
});
$('link-form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const data=Object.fromEntries(new FormData(e.target));const link=await request('/api/admin/links','POST',data);
    await load();const box=$('new-link');box.classList.remove('hidden');box.innerHTML=`<strong>Payment link is ready ✓</strong><div class="line"><input id="created-url" readonly value="${esc(link.url)}"><button class="btn primary" data-copy="${esc(link.url)}">Copy link</button><a class="btn secondary" href="${esc(link.url)}" target="_blank" rel="noopener">Open ↗</a></div>`;
    flash('Payment link created successfully.');
  }catch(err){explain(err);}
});
$('logo-upload').addEventListener('change',async e=>{
  const f=e.target.files?.[0];if(!f)return;
  if(f.size>250000){flash('Logo must be 250 KB or smaller.',true);return;}
  const reader=new FileReader();
  reader.onload=async()=>{try{const result=await request('/api/admin/logo','POST',{dataUrl:reader.result});
    document.querySelector('#brand-form [name=logoUrl]').value=result.logoUrl;
    flash('Logo uploaded. Click Save branding to display it on checkout.');
  }catch(err){explain(err);}};
  reader.readAsDataURL(f);
});
$('brand-form').addEventListener('submit',async e=>{
  e.preventDefault();try{await request('/api/admin/branding','PUT',Object.fromEntries(new FormData(e.target)));await load();flash('Gateway appearance saved.');}catch(err){explain(err);}
});
document.addEventListener('click',async e=>{
  const action=e.target.closest('[data-go],[data-tab],[data-copy],[data-default],[data-toggle],[data-link-toggle],[data-verify],[data-reject]');
  if(!action)return;
  try{
    if(action.dataset.tab||action.dataset.go){showTab(action.dataset.tab||action.dataset.go);return;}
    if(action.dataset.copy){await navigator.clipboard.writeText(action.dataset.copy);flash('Copied to clipboard.');return;}
    if(action.dataset.default){await request('/api/admin/accounts/'+action.dataset.default,'PATCH',{default:true});await load();flash('Default UPI account updated.');return;}
    if(action.dataset.toggle){await request('/api/admin/accounts/'+action.dataset.toggle,'PATCH',{active:action.dataset.active==='1'});await load();flash('UPI account updated.');return;}
    if(action.dataset.linkToggle){await request('/api/admin/links/'+action.dataset.linkToggle,'PATCH',{enabled:action.dataset.enabled==='1'});await load();flash('Payment link updated.');return;}
    if(action.dataset.verify){
      const utr=window.prompt('Only after verifying the matching credit in your bank app/statement, enter its REAL bank UTR/reference:');
      if(!utr)return;
      if(!window.confirm('I independently verified this exact bank credit, amount and receiving account. Mark this attempt PAID?'))return;
      await request('/api/admin/payments/'+action.dataset.verify+'/reconcile','POST',{action:'PAID',utr:utr.trim(),confirmedBank:true});
      await load();flash('Receipt recorded as bank-checked (manual verification).');return;
    }
    if(action.dataset.reject){if(!window.confirm('Reject this payment attempt?'))return;
      await request('/api/admin/payments/'+action.dataset.reject+'/reconcile','POST',{action:'REJECTED'});await load();flash('Payment attempt rejected.');}
  }catch(err){explain(err);}
});
init().catch(err=>{$('login-error').textContent=err.message;});
