/* ---------------------------------------------------------------
   DATE / FORMAT HELPERS - pure functions, no DOM, no DB. Shared by
   almost every other module.
   --------------------------------------------------------------- */
function toISO(d){ return d.toISOString().slice(0,10); }
function parseISO(s){ const [y,m,d]=s.split('-').map(Number); return new Date(Date.UTC(y,m-1,d)); }
function mondayOf(d){ const day=(d.getUTCDay()+6)%7; const r=new Date(d); r.setUTCDate(d.getUTCDate()-day); return r; }
function addDays(d,n){ const r=new Date(d); r.setUTCDate(d.getUTCDate()+n); return r; }
function fmtShort(d){ return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}); }
function cycleWeekFor(anchorISO, viewedMondayISO, cycleLength){
  const anchor = mondayOf(parseISO(anchorISO));
  const viewed = mondayOf(parseISO(viewedMondayISO));
  const diffDays = Math.round((viewed - anchor) / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);
  let idx = diffWeeks % cycleLength;
  if (idx < 0) idx += cycleLength;
  return idx + 1;
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Which "block" a slot belongs to within its group, given the pattern's
// block size (e.g. 4 consecutive roles = one 9-Day-Fortnight team).
function blockIndexFor(slotOrder, blockSize){
  return Math.floor(slotOrder / Math.max(1, blockSize));
}
