import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export function equalSecret(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
}
export function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('hex'); }
export function newSession(secret) {
  const data = `${Date.now() + 12*3600*1000}.${randomUUID()}`;
  return `${data}.${sign(data,secret)}`;
}
export function validSession(cookie, secret) {
  const segments = String(cookie||'').split('.');
  if (segments.length !== 3) return false;
  const value = `${segments[0]}.${segments[1]}`;
  return /^\d+$/.test(segments[0]) && Number(segments[0]) > Date.now() && equalSecret(sign(value, secret),segments[2]);
}
export function parseRupees(value, required=true) {
  const raw = String(value ?? '').trim();
  if (!raw && !required) return null;
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(raw)) throw new Error('Amount must be between ₹1 and ₹9,99,999.99');
  const [whole, fraction=''] = raw.split('.');
  const paise = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
  if (paise < 100 || paise > 99999999) throw new Error('Amount must be between ₹1 and ₹9,99,999.99');
  return paise;
}
export function rupees(paise) { return (Number(paise) / 100).toFixed(2); }
export function isValidVpa(vpa) { return /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9._-]{2,64}$/.test(vpa); }
export function upiUri(account, paise=null, transactionRef=null, title='Payment') {
  const p = new URLSearchParams({pa:account.vpa,pn:account.payee_name,cu:'INR'});
  if (paise !== null) p.set('am',rupees(paise));
  if (transactionRef) p.set('tr',transactionRef.slice(0,35));
  if (title) p.set('tn',title.slice(0,80));
  return `upi://pay?${p.toString()}`;
}
export function clean(value,limit=100) {return String(value ?? '').trim().slice(0,limit);}
