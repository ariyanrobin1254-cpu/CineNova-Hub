async function load(){const el=document.querySelector('#videos');try{const r=await fetch('/api/videos');const a=await r.json();document.querySelector('#count').textContent=`${a.length} videos`;el.innerHTML=a.map(v=>`<article class="video"><div class="thumb">${v.thumbnail_url?`<img src="${esc(v.thumbnail_url)}">`:'▶'}</div><div class="pad"><small>${esc(v.category)}</small><h3>${esc(v.title)}</h3><p>${esc(v.description||'')}</p><button onclick="openVideo('${v.id}')">Watch / Request</button></div></article>`).join('')||'<p class="muted">এখনো কোনো প্রকাশিত ভিডিও নেই।</p>'}catch{el.textContent='Unable to load videos.'}}function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function openVideo(id){
 const tg=window.Telegram?.WebApp;
 if(!tg || !tg.initData){
  alert('ভিডিও রিকোয়েস্ট করতে Telegram-এর ভিতর থেকে Mini App খুলুন।');
  return;
 }
 alert('Mini App interface প্রস্তুত। নিরাপদ Telegram WebApp verification ও Bot webhook সংযুক্ত না হওয়া পর্যন্ত ভিডিও ডেলিভারি বন্ধ রাখা হয়েছে।');
}
load();