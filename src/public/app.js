let state = { media: [], destinations: [], schedule: {} };
let library = { items: [], page: 1, pages: 1, total: 0 };
const selectedMedia = new Set();
const $ = (s) => document.querySelector(s);
const fmt = (b) =>
  b < 1048576
    ? `${(b / 1024).toFixed(0)} KB`
    : `${(b / 1048576).toFixed(1)} MB`;
function toast(t) {
  const e = $("#toast");
  e.textContent = t;
  e.classList.add("show");
  setTimeout(() => e.classList.remove("show"), 2600);
}
async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  if (r.status === 401) {
    location = "/login";
    throw Error("Sessão expirada");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || "Não foi possível concluir");
  return j;
}
async function load() {
  const [newState, newLibrary] = await Promise.all([
    api("/api/state"),
    api(`/api/media?page=${library.page}&pageSize=24`),
  ]);
  state = newState;
  library = newLibrary;
  render();
}
async function loadLibrary(page = library.page) {
  library = await api(`/api/media?page=${page}&pageSize=24`);
  renderLibrary();
}
function render() {
  total.textContent = state.stats.total;
  storage.textContent = `${fmt(state.stats.bytes)} armazenados`;
  sent.textContent = state.stats.sent;
  pending.textContent = state.stats.pending;
  const on = !!state.schedule.enabled;
  status.textContent = on ? "Publicando" : "Parado";
  status.className = on ? "status-on" : "status-off";
  scheduleBadge.textContent = on ? "ATIVO" : "INATIVO";
  scheduleBadge.className = on ? "badge on" : "badge";
  nextRun.textContent = on
    ? state.schedule.next_run_at
      ? "próximo envio programado"
      : "processando"
    : "aguardando configuração";
  dailyLimit.value = state.schedule.daily_limit || 20;
  intervalMinutes.value = state.schedule.interval_minutes || 5;
  destinationId.innerHTML = state.destinations.length
    ? state.destinations
        .map(
          (d) =>
            `<option value="${d.id}" ${d.id === state.schedule.destination_id ? "selected" : ""}>${esc(d.name)}</option>`,
        )
        .join("")
    : '<option value="">Cadastre um destino primeiro</option>';
  recent.innerHTML =
    state.media.slice(0, 5).map(mediaRow).join("") ||
    empty("Nenhum conteúdo ainda.");
  renderLibrary();
  destinations.innerHTML =
    state.destinations.map(destinationCard).join("") ||
    empty("Nenhum grupo ou canal configurado.");
}
function renderLibrary() {
  mediaGrid.innerHTML =
    library.items.map(mediaCard).join("") ||
    empty("Arraste seus primeiros vídeos ou imagens.");
  const pageIds = library.items.map((item) => item.id);
  const selectedOnPage = pageIds.filter((id) => selectedMedia.has(id)).length;
  selectPage.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
  selectPage.indeterminate =
    selectedOnPage > 0 && selectedOnPage < pageIds.length;
  selectionCount.textContent = `${selectedMedia.size} selecionado${selectedMedia.size === 1 ? "" : "s"}`;
  deleteSelected.disabled = selectedMedia.size === 0;
  clearSelection.hidden = selectedMedia.size === 0;
  libraryPagination.innerHTML = library.total
    ? `<button class="page-button" type="button" onclick="changeLibraryPage(${library.page - 1})" ${library.page <= 1 ? "disabled" : ""}>← Anterior</button><span class="page-status">Página ${library.page} de ${library.pages} · ${library.total} arquivos</span><button class="page-button" type="button" onclick="changeLibraryPage(${library.page + 1})" ${library.page >= library.pages ? "disabled" : ""}>Próxima →</button>`
    : "";
}
function esc(s) {
  return String(s).replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
}
function empty(t) {
  return `<div class="muted" style="padding:24px 0">${t}</div>`;
}
function mediaRow(m) {
  return `<div class="recent-item"><${m.mime_type.startsWith("video/") ? "video muted" : "img"} class="thumb" src="/api/media/${m.id}/file"></${m.mime_type.startsWith("video/") ? "video" : "img"}><div><strong>${esc(m.original_name)}</strong><small>${fmt(m.size)} · enviado ${m.sent_count}x</small></div></div>`;
}
function mediaCard(m) {
  const tag = m.mime_type.startsWith("video/")
    ? `<video class="media-preview" src="/api/media/${m.id}/file" controls preload="metadata"></video>`
    : `<img class="media-preview" src="/api/media/${m.id}/file" loading="lazy">`;
  return `<article class="media-card ${selectedMedia.has(m.id) ? "selected" : ""}"><label class="media-select" title="Selecionar ${esc(m.original_name)}"><input type="checkbox" ${selectedMedia.has(m.id) ? "checked" : ""} onchange="toggleMediaSelection(${m.id},this.checked)"></label>${tag}<div class="media-info"><strong title="${esc(m.original_name)}">${esc(m.original_name)}</strong><small>${fmt(m.size)}</small><div class="media-actions"><small>Enviado para ${m.sent_count} destino(s)</small><button class="icon-btn" onclick="removeMedia(${m.id})">Excluir</button></div></div></article>`;
}
function toggleMediaSelection(id, checked) {
  checked ? selectedMedia.add(id) : selectedMedia.delete(id);
  renderLibrary();
}
selectPage.onchange = () => {
  for (const item of library.items) {
    selectPage.checked
      ? selectedMedia.add(item.id)
      : selectedMedia.delete(item.id);
  }
  renderLibrary();
};
clearSelection.onclick = () => {
  selectedMedia.clear();
  renderLibrary();
};
async function changeLibraryPage(page) {
  if (page < 1 || page > library.pages || page === library.page) return;
  await loadLibrary(page);
  libraryToolbar.scrollIntoView({ behavior: "smooth", block: "start" });
}
deleteSelected.onclick = async () => {
  const ids = [...selectedMedia];
  if (!ids.length) return;
  if (
    !confirm(
      `Excluir definitivamente ${ids.length} arquivo${ids.length === 1 ? "" : "s"}? Esta ação também remove esses itens da fila.`,
    )
  )
    return;
  try {
    const result = await api("/api/media/bulk-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    ids.forEach((id) => selectedMedia.delete(id));
    toast(
      `${result.deleted} arquivo${result.deleted === 1 ? " excluído" : "s excluídos"}`,
    );
    await load();
  } catch (error) {
    toast(error.message);
  }
};
function destinationCard(d) {
  return `<article class="destination"><span class="badge on">CONECTADO</span><h3>${esc(d.name)}</h3><code>${esc(d.chat_id)}</code><div class="actions"><button class="primary" onclick="testDestination(${d.id})">Testar envio</button><button class="danger" onclick="removeDestination(${d.id})">Excluir</button></div></article>`;
}
function showView(id) {
  document
    .querySelectorAll(".view")
    .forEach((e) => e.classList.toggle("hidden", e.id !== id));
  document
    .querySelectorAll(".nav")
    .forEach((e) => e.classList.toggle("active", e.dataset.view === id));
}
document
  .querySelectorAll(".nav")
  .forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function openUpload() {
  uploadDialog.showModal();
}
files.onchange = () =>
  (fileList.innerHTML = [...files.files]
    .map((f) => `<div>• ${esc(f.name)} — ${fmt(f.size)}</div>`)
    .join(""));
["dragenter", "dragover"].forEach((n) =>
  dropzone.addEventListener(n, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((n) =>
  dropzone.addEventListener(n, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  }),
);
dropzone.addEventListener("drop", (e) => {
  files.files = e.dataTransfer.files;
  files.onchange();
});
uploadForm.onsubmit = (e) => {
  e.preventDefault();
  if (!files.files.length) return toast("Escolha pelo menos um arquivo");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/media");
  xhr.upload.onprogress = (e) => {
    progress.hidden = false;
    progress.value = (e.loaded / e.total) * 100;
  };
  xhr.onload = async () => {
    progress.hidden = true;
    if (xhr.status < 300) {
      uploadDialog.close();
      uploadForm.reset();
      fileList.innerHTML = "";
      toast("Conteúdos salvos");
      await load();
    } else toast(JSON.parse(xhr.responseText).error || "Falha no upload");
  };
  xhr.send(new FormData(uploadForm));
};
destinationForm.onsubmit = async (e) => {
  e.preventDefault();
  destError.textContent = "";
  try {
    await api("/api/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    destinationDialog.close();
    e.target.reset();
    toast("Destino conectado");
    load();
  } catch (x) {
    destError.textContent = x.message;
  }
};
scheduleForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinationId: destinationId.value,
        dailyLimit: dailyLimit.value,
        intervalMinutes: intervalMinutes.value,
      }),
    });
    toast("Publicações iniciadas");
    load();
  } catch (x) {
    toast(x.message);
  }
};
stopBtn.onclick = async () => {
  await api("/api/schedule/stop", { method: "POST" });
  toast("Publicações pausadas");
  load();
};
async function removeMedia(id) {
  if (!confirm("Excluir este arquivo definitivamente?")) return;
  await api(`/api/media/${id}`, { method: "DELETE" });
  selectedMedia.delete(id);
  toast("Arquivo excluído");
  await load();
}
async function removeDestination(id) {
  if (!confirm("Excluir este destino e o histórico dele?")) return;
  await api(`/api/destinations/${id}`, { method: "DELETE" });
  toast("Destino excluído");
  load();
}
async function testDestination(id) {
  try {
    await api(`/api/destinations/${id}/test`, { method: "POST" });
    toast("Mensagem de teste enviada");
  } catch (x) {
    toast(x.message);
  }
}
logout.onclick = async () => {
  await api("/api/logout", { method: "POST" });
  location = "/login";
};
load();
setInterval(async () => {
  state = await api("/api/state");
  render();
}, 30000);
