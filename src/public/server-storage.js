function formatDisk(bytes){const gb=bytes/1073741824;return `${gb.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})} GB`}
function updateServerStorage(){
  const disk=state?.stats?.disk;if(!disk||!disk.total)return;
  const warning=disk.percent>=85,critical=disk.percent>=95;
  serverDiskFree.textContent=formatDisk(disk.free);
  serverDiskFree.style.color=critical?'var(--red)':warning?'#c27a00':'';
  serverDiskInfo.textContent=`livres de ${formatDisk(disk.total)} · ${disk.percent}% usado`;
  serverDiskBar.value=disk.percent;
  serverDiskBar.style.accentColor=critical?'var(--red)':warning?'#c27a00':'var(--green)';
}
document.querySelector('.stats').insertAdjacentHTML('beforeend','<article id="serverDiskCard"><span>Espaço no servidor</span><strong id="serverDiskFree">—</strong><small id="serverDiskInfo">calculando espaço…</small><progress id="serverDiskBar" max="100" value="0" style="height:7px;margin-top:10px"></progress></article>');
setInterval(updateServerStorage,1000);
setTimeout(updateServerStorage,300);
