function updateScheduleCountdown(){
  if(!state?.schedule?.enabled){nextRun.textContent='aguardando configuração';return;}
  const raw=state.schedule.next_run_at;if(!raw){nextRun.textContent='processando envio…';return;}
  const target=new Date(raw.replace(' ','T')+'Z');const seconds=Math.max(0,Math.ceil((target-Date.now())/1000));
  if(seconds<=15){nextRun.textContent='enviando agora…';return;}
  const min=Math.floor(seconds/60),sec=seconds%60;nextRun.textContent=`próximo em ${min}m ${String(sec).padStart(2,'0')}s`;
}
setInterval(updateScheduleCountdown,1000);
setTimeout(updateScheduleCountdown,300);
