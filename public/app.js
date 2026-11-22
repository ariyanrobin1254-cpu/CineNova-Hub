let tgUser=null;
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
async function load(){
 const el=document.querySelector('#videos');
 try{
  const r=await fetch('/api/videos'); const a=await r.json();
  document.querySelector('#count').textContent=`${a.length} videos`;
  el.innerHTML=a.map(v=>`<article class="video"><div class="thumb">${v.thumbnail_url?`<img src="${esc(v.thumbnail_url)}">`:'▶'}</div><div class="pad"><small>${esc(v.category)}</small><h3>${esc(v.title)}</h3><p>${esc(v.description||'')}</p><button ${tgUser?'':'disabled'} onclick="requestVideo('${esc(v.id)}')">Bot-এ ভিডিও নিন</button></div></article>`).join('')||'<p class="muted">এখনো কোনো প্রকাশিত ভিডিও নেই।</p>';
 }catch{el.textContent='Unable to load videos.'}
}
async function requestVideo(id){
 const initData=window.Telegram?.WebApp?.initData;
 if(!initData){alert('Telegram Bot-এর Mini App থেকে ওয়েবসাইট খুলুন।');return;}
 const r=await fetch('/api/deliver',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData,videoId:id})});
 const j=await r.json();
 if(!r.ok){alert(j.error||'ভিডিও পাঠানো যায়নি।');return;}
 alert('ভিডিও আপনার Telegram chat-এ পাঠানো হয়েছে।');
}
window.requestVideo=requestVideo;
async function init(){
 const tg=window.Telegram?.WebApp;
 if(tg?.initData){tg.ready();tg.expand();try{const r=await fetch('/api/telegram/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData:tg.initData})});tgUser=r.ok;}catch{tgUser=false;}}
 await load();
}
init();
