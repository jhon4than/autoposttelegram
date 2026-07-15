const telegramUi = {
  step: 'phone',
  async open() {
    telegramAccountDialog.showModal();
    telegramFlow.innerHTML = '<p class="muted">Verificando sua conexão…</p>';
    try {
      const account = await api('/api/telegram/account');
      if (account.connected) return this.showGroups(account.phone);
      this.showPhone();
    } catch (e) { telegramFlow.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  },
  showPhone() {
    telegramFlow.innerHTML = `<label>Número do Telegram com DDI<input id="tgPhone" type="tel" placeholder="+5511999999999"></label><button class="primary full" onclick="telegramUi.sendCode()">Receber código no Telegram</button><p class="muted" style="font-size:12px;margin-top:12px">A sessão será criptografada e usada somente para listar seus grupos e canais.</p>`;
  },
  async sendCode() {
    try {
      await api('/api/telegram/login/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:tgPhone.value})});
      telegramFlow.innerHTML = `<label>Código recebido no Telegram<input id="tgCode" inputmode="numeric" autocomplete="one-time-code" placeholder="12345"></label><button class="primary full" onclick="telegramUi.confirmCode()">Confirmar código</button>`;
    } catch(e) { toast(e.message); }
  },
  async confirmCode() {
    try {
      const result=await api('/api/telegram/login/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:tgCode.value})});
      if(result.passwordRequired){telegramFlow.innerHTML=`<label>Senha de duas etapas<input id="tgPassword" type="password" placeholder="Sua senha 2FA"></label><button class="primary full" onclick="telegramUi.confirmPassword()">Conectar conta</button>`;return;}
      this.showGroups();
    } catch(e) { toast(e.message); }
  },
  async confirmPassword() {
    try {await api('/api/telegram/login/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:tgPassword.value})});this.showGroups();} catch(e){toast(e.message);}
  },
  async showGroups(phone='') {
    telegramFlow.innerHTML='<p class="muted">Carregando grupos e canais…</p>';
    try {
      const {items}=await api('/api/telegram/dialogs');
      telegramFlow.innerHTML=`<div class="panel-head"><div><strong>Conta conectada</strong><p>${esc(phone||'Telegram')}</p></div><button class="danger" onclick="telegramUi.disconnect()">Desconectar</button></div><label style="margin-top:16px">Buscar<input id="tgSearch" placeholder="Nome do grupo ou canal" oninput="telegramUi.filter(this.value)"></label><div id="tgGroups" style="max-height:380px;overflow:auto;margin-top:10px"></div>`;
      this.items=items;this.filter('');
    } catch(e){telegramFlow.innerHTML=`<p class="error">${esc(e.message)}</p><button class="primary full" onclick="telegramUi.showPhone()">Conectar novamente</button>`;}
  },
  filter(q) {
    const normalized=q.toLowerCase();
    tgGroups.innerHTML=this.items.filter(x=>x.name.toLowerCase().includes(normalized)).map((x,i)=>`<button class="recent-item" style="width:100%;border:0;background:white;text-align:left;cursor:pointer" onclick="telegramUi.pick(${i})"><div><strong>${esc(x.name)}</strong><small>${esc(x.type)} · ${x.chatId}</small></div><span>＋</span></button>`).join('')||'<p class="muted" style="padding:16px">Nenhum destino encontrado.</p>';
    this.filtered=this.items.filter(x=>x.name.toLowerCase().includes(normalized));
  },
  pick(i) {
    const item=this.filtered[i];telegramAccountDialog.close();destinationDialog.showModal();
    destinationForm.elements.name.value=item.name;destinationForm.elements.chatId.value=item.chatId;destinationForm.elements.botToken.focus();
    toast('Destino preenchido. Informe apenas o bot token.');
  },
  async disconnect(){if(!confirm('Desconectar sua conta do Telegram?'))return;await api('/api/telegram/account',{method:'DELETE'});this.showPhone();}
};

document.querySelector('#settings .title-row').insertAdjacentHTML('beforeend','<button class="ghost" style="border:1px solid var(--line);padding:13px 18px;border-radius:11px" onclick="telegramUi.open()">◉ Buscar meus grupos</button>');
document.body.insertAdjacentHTML('beforeend',`<dialog id="telegramAccountDialog"><button class="dialog-close" onclick="telegramAccountDialog.close()">×</button><h2>Conectar sua conta</h2><p class="muted" style="margin:6px 0 20px">Escolha grupos e canais sem procurar o ID manualmente.</p><div id="telegramFlow"></div></dialog>`);
