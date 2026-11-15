// ─────────────────────────────────────────────────────────────────────────
// Colegas: quién cubre cada evento, cuánto se le paga, pagos, descuentos
// (de una vez o en cuotas), calendario privado por colega y acceso a la
// carpeta de Drive del evento para que suba las fotos.
//
// Lee y escribe DIRECTO en Supabase (tablas colleague*), fila por fila. No
// pasa por syncCloudState() de cloud.js, así el sync automático de
// clientes/tareas nunca toca estos datos.
//
// app.js solo se engancha en 7 lugares: import, render(), panel en
// openClientDetail(), setView(), loadColleagues() al arrancar,
// resetColleagues() al cerrar sesión e initColleagues() antes de bootstrap().
// ─────────────────────────────────────────────────────────────────────────
import { cloudEnabled, supabase } from "./cloud.js";

const PRODUCTION_ORIGIN = "https://janos-control.vercel.app";

let deps = null;
let data = emptyData();
let status = "idle"; // idle | loading | ready | error
let loadError = "";
let showInactive = false;
let openColleagueId = null;

function emptyData() { return { colleagues: [], coverages: [], payments: [], discounts: [], applications: [] }; }

// ── utilidades ────────────────────────────────────────────────────────────
const esc = (v) => deps.escapeHtml(v ?? "");
const money = (v) => deps.money(Number(v) || 0);
const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function hhmm(t) { return t ? String(t).slice(0, 5) : ""; }
function dateLong(iso) {
  if (!iso) return "Sin fecha";
  const s = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${iso}T12:00:00`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Usa el toast de app.js, pero lo deja dentro del diálogo que está más
// arriba (si no, quedaría tapado por el formulario de colegas).
function toast(msg, duration) {
  deps.toast(msg, duration);
  const t = document.getElementById("toast");
  const top = [...document.querySelectorAll("dialog[open]")].at(-1);
  if (t && top && t.parentElement !== top) top.appendChild(t);
}
function firstName(name) { return String(name || "").trim().split(/\s+/)[0] || ""; }
function clientById(id) { return deps.getClients().find((c) => c.id === id) || null; }
function colleagueById(id) { return data.colleagues.find((c) => c.id === id) || null; }
function coverageDate(cv) { return clientById(cv.client_id)?.eventDate || ""; }
function isDue(cv) { const d = coverageDate(cv); return Boolean(d) && d <= today(); }
function byDate(a, b) { return coverageDate(a).localeCompare(coverageDate(b)); }
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim()); }

function friendlyError(error) {
  const msg = String(error?.message || error || "");
  if (error?.code === "23505" && /colleagues_owner_name/.test(msg)) return "Ya tenés un colega con ese nombre.";
  if (error?.code === "23505" && /client_id_colleague_id/.test(msg)) return "Ese colega ya está asignado a este evento.";
  if (error?.code === "23503") return "Tiene coberturas, pagos o descuentos registrados: desactivalo en vez de borrarlo.";
  if (/otro usuario/.test(msg)) return "Este evento todavía no terminó de guardarse en la nube. Esperá unos segundos y probá de nuevo.";
  return msg || "No se pudo guardar. Probá de nuevo.";
}
async function run(promise) { const { data: rows, error } = await promise; if (error) throw new Error(friendlyError(error)); return rows; }

async function fetchAll(table, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await run(supabase.from(table).select("*").order(order).order("id").range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// ── cálculos ──────────────────────────────────────────────────────────────
function discountApplied(d) { return num(data.applications.filter((a) => a.discount_id === d.id).reduce((s, a) => s + Number(a.amount), 0)); }
function discountRemaining(d) { return num(Number(d.total_amount) - discountApplied(d)); }
function suggestedInstallment(d) {
  const rem = discountRemaining(d);
  if (rem <= 0) return 0;
  const cuota = num(Number(d.total_amount) / Math.max(1, d.installments));
  return rem - cuota < 1 ? rem : Math.min(rem, cuota);
}
function installmentNumber(d, paymentId) {
  const apps = data.applications.filter((a) => a.discount_id === d.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return apps.findIndex((a) => a.payment_id === paymentId) + 1;
}
function summary(colleague) {
  const mine = data.coverages.filter((cv) => cv.colleague_id === colleague.id);
  const unpaid = mine.filter((cv) => !cv.payment_id);
  const due = unpaid.filter(isDue);
  const gross = num(due.reduce((s, cv) => s + Number(cv.amount), 0));
  const discounts = data.discounts.filter((d) => d.colleague_id === colleague.id && discountRemaining(d) > 0);
  const nextCuotas = num(discounts.reduce((s, d) => s + suggestedInstallment(d), 0));
  const upcoming = mine.filter((cv) => coverageDate(cv) >= today()).sort(byDate);
  return {
    mine, unpaid, due, gross,
    net: num(Math.max(0, gross - Math.min(gross, nextCuotas))),
    future: num(unpaid.filter((cv) => !isDue(cv)).reduce((s, cv) => s + Number(cv.amount), 0)),
    discountLeft: num(discounts.reduce((s, d) => s + discountRemaining(d), 0)),
    next: upcoming[0] || null,
  };
}

// ── carga ─────────────────────────────────────────────────────────────────
export async function loadColleagues() {
  if (!cloudEnabled || !deps?.isSignedIn()) return;
  status = "loading"; loadError = "";
  try {
    const [colleagues, coverages, payments, discounts, applications] = await Promise.all([
      fetchAll("colleagues", "name"),
      fetchAll("colleague_coverages", "created_at"),
      fetchAll("colleague_payments", "paid_on"),
      fetchAll("colleague_discounts", "created_on"),
      fetchAll("colleague_discount_applications", "created_at"),
    ]);
    data = { colleagues, coverages, payments, discounts, applications };
    status = "ready";
  } catch (err) {
    console.error(err);
    status = "error"; loadError = err.message;
  }
  refreshAll();
}
export function resetColleagues() { data = emptyData(); status = "idle"; openColleagueId = null; closeDialog("colDetailDialog"); closeDialog("colFormDialog"); }

function refreshAll(clientId) {
  renderColleagues();
  if (openColleagueId && document.getElementById("colDetailDialog")?.open) openColleagueDetail(openColleagueId);
  const detail = document.getElementById("detailDialog");
  if (detail?.open) {
    const id = clientId || detail.querySelector("[data-col-panel]")?.dataset.colPanel;
    if (id) deps.refreshClientDetail(id);
  }
}

// ── vista "Colegas" ───────────────────────────────────────────────────────
export function renderColleagues() {
  const root = document.getElementById("colleaguesView");
  if (!root || !deps) return;
  if (!cloudEnabled || !deps.isSignedIn()) { root.innerHTML = `<div class="panel"><div class="empty"><strong>Colegas</strong>Iniciá sesión para llevar el control de tu equipo.</div></div>`; return; }
  if (status === "loading" || status === "idle") { root.innerHTML = `<div class="panel"><div class="empty">Cargando colegas…</div></div>`; return; }
  if (status === "error") { root.innerHTML = `<div class="panel"><div class="empty"><strong>No se pudieron cargar los colegas</strong>${esc(loadError)}<br><br><button class="secondary-btn" data-col="reload">Reintentar</button></div></div>`; return; }

  const list = data.colleagues.filter((c) => showInactive || c.active);
  const sums = data.colleagues.filter((c) => c.active).map(summary);
  const totalOwed = num(sums.reduce((s, x) => s + x.net, 0));
  const upcomingCount = data.coverages.filter((cv) => coverageDate(cv) >= today()).length;
  const discountLeft = num(sums.reduce((s, x) => s + x.discountLeft, 0));
  const inactiveCount = data.colleagues.filter((c) => !c.active).length;

  root.innerHTML = `
    <div class="col-toolbar">
      <div class="col-stats">
        <div class="col-stat col-stat-gold"><span>Les debés en total</span><strong>${money(totalOwed)}</strong><small>eventos ya realizados, con cuotas descontadas</small></div>
        <div class="col-stat"><span>Coberturas próximas</span><strong>${upcomingCount}</strong><small>de hoy en adelante</small></div>
        <div class="col-stat"><span>Descuentos por cobrar</span><strong>${money(discountLeft)}</strong><small>equipos u otros adelantos</small></div>
      </div>
      <div class="col-toolbar-actions">
        ${inactiveCount ? `<label class="col-toggle"><input type="checkbox" data-col-toggle-inactive ${showInactive ? "checked" : ""}> Ver inactivos (${inactiveCount})</label>` : ""}
        <button class="primary-btn" data-col="new-colleague">+ Agregar colega</button>
      </div>
    </div>
    ${list.length ? `<div class="col-grid">${list.map(cardHtml).join("")}</div>` : `<div class="panel"><div class="empty"><strong>Todavía no cargaste colegas</strong>Agregá a las personas que cubren tus eventos con su tarifa, WhatsApp y Gmail.<br><br><button class="primary-btn" data-col="new-colleague">+ Agregar el primero</button></div></div>`}`;
}

function cardHtml(c) {
  const s = summary(c);
  const nextClient = s.next ? clientById(s.next.client_id) : null;
  return `<article class="col-card ${c.active ? "" : "inactive"}">
    <header class="col-card-head">
      <div class="col-avatar">${esc(firstName(c.name).charAt(0).toUpperCase() || "?")}</div>
      <div class="col-card-name"><strong>${esc(c.name)}</strong><span>${esc(c.role || "Sin función")}${c.active ? "" : " · Inactivo"}</span></div>
      <button class="icon-btn col-edit" title="Editar colega" data-col="edit-colleague" data-id="${c.id}">✎</button>
    </header>
    <div class="col-owed ${s.net > 0 ? "has-debt" : ""}"><span>Le debés</span><strong>${money(s.net)}</strong>${s.gross !== s.net ? `<small>${money(s.gross)} − cuota de descuento</small>` : `<small>${s.due.length ? `${s.due.length} ${s.due.length === 1 ? "evento" : "eventos"} sin pagar` : "Está al día"}</small>`}</div>
    <dl class="col-facts">
      <div><dt>Próxima cobertura</dt><dd>${nextClient ? `${esc(deps.dateText(nextClient.eventDate))} · ${esc(nextClient.honoree)}` : "—"}</dd></div>
      <div><dt>A futuro</dt><dd>${money(s.future)}</dd></div>
      <div><dt>Descuentos pendientes</dt><dd>${money(s.discountLeft)}</dd></div>
      <div><dt>Tarifa</dt><dd>${money(c.default_fee)}</dd></div>
    </dl>
    <div class="col-card-contact">${c.phone ? `<span>📱 ${esc(c.phone)}</span>` : `<span class="col-missing">Sin WhatsApp</span>`}${c.email ? `<span>✉ ${esc(c.email)}</span>` : `<span class="col-missing">Sin Gmail (para Drive)</span>`}</div>
    <footer class="col-card-actions">
      <button class="secondary-btn" data-col="open-colleague" data-id="${c.id}">Ver detalle</button>
      <button class="secondary-btn" data-col="calendar" data-id="${c.id}" ${c.active ? "" : "disabled"}>📅 Calendario</button>
      <button class="primary-btn" data-col="pay" data-id="${c.id}">Registrar pago</button>
    </footer>
  </article>`;
}

// ── panel en la ficha del evento ──────────────────────────────────────────
export function colleaguesPanelHtml(client) {
  if (!cloudEnabled || !deps?.isSignedIn() || !client) return "";
  if (status !== "ready") {
    return `<div class="col-cover-panel" data-col-panel="${client.id}"><div class="col-cover-head"><div><span>Cobertura de colegas</span><strong>${status === "error" ? "No se pudieron cargar" : "Cargando…"}</strong></div>${status === "error" ? `<button class="ghost-btn" data-col="reload">Reintentar</button>` : ""}</div></div>`;
  }
  const covers = data.coverages.filter((cv) => cv.client_id === client.id).sort((a, b) => hhmm(a.arrival_time).localeCompare(hhmm(b.arrival_time)));
  const noFolder = covers.length && !client.driveUrl;
  return `<div class="col-cover-panel" data-col-panel="${client.id}">
    <div class="col-cover-head">
      <div><span>Cobertura de colegas</span><strong>${covers.length ? `${covers.length} ${covers.length === 1 ? "asignado" : "asignados"}` : "Nadie asignado"}</strong></div>
      <button class="secondary-btn" data-col="assign" data-id="${client.id}">+ Asignar colega</button>
    </div>
    ${noFolder ? `<div class="col-warn">⚠ Este evento todavía no tiene carpeta de Drive. Creala con <b>«Crear carpeta en Drive»</b> (abajo) para que los colegas puedan subir las fotos.</div>` : ""}
    ${covers.map((cv) => coverRowHtml(cv, client)).join("")}
  </div>`;
}

function driveChip(cv, client, colleague) {
  if (cv.drive_shared_at && cv.drive_shared_email === colleague?.email) return `<span class="col-chip ok" title="Compartida con ${esc(cv.drive_shared_email)}">📁 Drive compartido</span>`;
  if (!client.driveUrl) return `<span class="col-chip warn" title="Primero creá la carpeta de Drive del evento">📁 Sin carpeta</span>`;
  if (!colleague?.email) return `<button class="col-chip warn" data-col="edit-colleague" data-id="${colleague?.id}" title="Cargale el Gmail para compartirle la carpeta">📁 Falta Gmail</button>`;
  return `<button class="col-chip action" data-col="share-drive" data-id="${cv.id}">📁 Compartir Drive</button>`;
}

function coverRowHtml(cv, client) {
  const c = colleagueById(cv.colleague_id);
  const paid = data.payments.find((p) => p.id === cv.payment_id);
  const time = cv.arrival_time ? `${hhmm(cv.arrival_time)}${cv.end_time ? `–${hhmm(cv.end_time)}` : ""} h` : "Sin horario";
  return `<div class="col-cover-row">
    <div class="col-cover-main"><strong>${esc(c?.name || "Colega")}</strong><span>${esc(cv.role || c?.role || "")}${cv.role || c?.role ? " · " : ""}${esc(time)}${cv.location ? ` · ${esc(cv.location)}` : ""}</span>${cv.notes ? `<small>${esc(cv.notes)}</small>` : ""}</div>
    <div class="col-cover-side">
      <strong>${money(cv.amount)}</strong>
      ${paid ? `<span class="col-chip ok">Pagado ${esc(deps.dateText(paid.paid_on))}</span>` : `<span class="col-chip">Pendiente</span>`}
      ${driveChip(cv, client, c)}
      <button class="icon-btn col-mini" title="Mandar día, hora y lugar por WhatsApp" data-col="wa-coverage" data-id="${cv.id}">💬</button>
      <button class="icon-btn col-mini" title="Editar" data-col="edit-coverage" data-id="${cv.id}">✎</button>
      <button class="icon-btn col-mini" title="Quitar" data-col="del-coverage" data-id="${cv.id}">×</button>
    </div>
  </div>`;
}

// ── diálogos ──────────────────────────────────────────────────────────────
function ensureDialogs() {
  for (const id of ["colDetailDialog", "colFormDialog"]) {
    if (document.getElementById(id)) continue;
    const d = document.createElement("dialog");
    d.id = id; d.className = `modal ${id === "colDetailDialog" ? "col-detail-modal" : "col-form-modal"}`;
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    d.addEventListener("close", () => { if (id === "colDetailDialog") openColleagueId = null; });
    document.body.appendChild(d);
  }
}
function showDialog(id, html) {
  ensureDialogs();
  const d = document.getElementById(id);
  // toast() de app.js mete el aviso dentro del diálogo abierto: lo saco antes
  // de reemplazar el contenido para no borrarlo.
  const t = document.getElementById("toast");
  if (t && d.contains(t)) document.body.appendChild(t);
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
function closeDialog(id) { const d = document.getElementById(id); if (d?.open) d.close(); }
function head(eyebrow, title, closeId) { return `<div class="modal-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2></div><button class="icon-btn" type="button" data-col="close" data-id="${closeId}" aria-label="Cerrar">×</button></div>`; }

// Alta / edición de colega
function openColleagueForm(colleague) {
  const c = colleague || { name: "", role: "", phone: "", email: "", default_fee: 0, notes: "", active: true };
  showDialog("colFormDialog", `<form id="colColleagueForm" data-id="${c.id || ""}">
    ${head("Equipo", c.id ? `Editar ${c.name}` : "Nuevo colega", "colFormDialog")}
    <div class="form-grid">
      <label>Nombre y apellido<input name="name" required maxlength="80" value="${esc(c.name)}" placeholder="Ej. Dylan Pérez"></label>
      <label>Función<input name="role" maxlength="60" value="${esc(c.role || "")}" placeholder="Fotógrafo, videógrafo, asistente…" list="colRoleList"></label>
      <label>WhatsApp<input name="phone" type="tel" inputmode="tel" value="${esc(c.phone || "")}" placeholder="Ej. 11 2345 6789"></label>
      <label>Gmail (para compartirle Drive)<input name="email" type="email" inputmode="email" value="${esc(c.email || "")}" placeholder="nombre@gmail.com"></label>
      <label>Tarifa por evento<input name="default_fee" type="number" min="0" step="1" inputmode="numeric" value="${Number(c.default_fee) || ""}" placeholder="Ej. 60000"></label>
      ${c.id ? `<label class="col-check"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Activo (si lo desactivás, deja de funcionar su calendario)</label>` : ""}
    </div>
    <label class="full-label">Notas<textarea name="notes" rows="2" placeholder="Alias para transferir, equipo que usa, etc.">${esc(c.notes || "")}</textarea></label>
    <datalist id="colRoleList"><option>Fotógrafo</option><option>Videógrafo</option><option>Asistente</option><option>Drone</option></datalist>
    <div class="modal-actions">
      ${c.id ? `<button class="danger-btn" type="button" data-col="del-colleague" data-id="${c.id}">Borrar</button>` : ""}
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">Guardar</button>
    </div>
  </form>`);
}

async function saveColleagueForm(form) {
  const f = new FormData(form);
  const email = String(f.get("email") || "").trim().toLowerCase();
  if (email && !validEmail(email)) { toast("Revisá el Gmail: no parece un mail válido."); return; }
  const row = {
    name: String(f.get("name") || "").trim(),
    role: String(f.get("role") || "").trim() || null,
    phone: String(f.get("phone") || "").trim() || null,
    email: email || null,
    default_fee: num(f.get("default_fee")),
    notes: String(f.get("notes") || "").trim() || null,
  };
  if (!row.name) { toast("Poné el nombre del colega."); return; }
  const id = form.dataset.id;
  if (id) row.active = f.get("active") === "on";
  await withBusy(form, async () => {
    if (id) {
      const [saved] = await run(supabase.from("colleagues").update(row).eq("id", id).select());
      data.colleagues = data.colleagues.map((c) => (c.id === id ? saved : c));
    } else {
      const [saved] = await run(supabase.from("colleagues").insert(row).select());
      data.colleagues = [...data.colleagues, saved].sort((a, b) => a.name.localeCompare(b.name));
    }
    closeDialog("colFormDialog");
    toast(id ? "Colega actualizado" : "Colega agregado");
    refreshAll();
  });
}

async function deleteColleague(id) {
  const c = colleagueById(id); if (!c) return;
  const used = data.coverages.some((x) => x.colleague_id === id) || data.payments.some((x) => x.colleague_id === id) || data.discounts.some((x) => x.colleague_id === id);
  if (used) {
    if (!confirm(`${c.name} tiene coberturas, pagos o descuentos registrados, así que no se puede borrar sin perder el historial.\n\n¿Lo desactivo? (deja de aparecer en la lista y su calendario deja de funcionar)`)) return;
    const [saved] = await run(supabase.from("colleagues").update({ active: false }).eq("id", id).select());
    data.colleagues = data.colleagues.map((x) => (x.id === id ? saved : x));
    toast("Colega desactivado");
  } else {
    if (!confirm(`¿Borrar a ${c.name}?`)) return;
    await run(supabase.from("colleagues").delete().eq("id", id));
    data.colleagues = data.colleagues.filter((x) => x.id !== id);
    toast("Colega borrado");
  }
  closeDialog("colFormDialog"); closeDialog("colDetailDialog");
  refreshAll();
}

// Asignar / editar una cobertura desde la ficha del evento
function lastLocationForSalon(salon) {
  const sameSalon = data.coverages.filter((cv) => cv.location && clientById(cv.client_id)?.salon === salon).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return sameSalon[0]?.location || "";
}

function openCoverageForm(clientId, coverage) {
  const client = clientById(clientId); if (!client) return;
  const cv = coverage || { colleague_id: "", role: "", arrival_time: "", end_time: "", location: lastLocationForSalon(client.salon) || client.salon || "", amount: "", notes: "" };
  const paid = Boolean(coverage?.payment_id);
  const taken = new Set(data.coverages.filter((x) => x.client_id === clientId && x.id !== coverage?.id).map((x) => x.colleague_id));
  const options = data.colleagues.filter((c) => (c.active || c.id === cv.colleague_id) && !taken.has(c.id));
  showDialog("colFormDialog", `<form id="colCoverageForm" data-client="${clientId}" data-id="${coverage?.id || ""}">
    ${head(`#${client.code} · ${client.salon} · ${deps.dateText(client.eventDate)}`, coverage ? "Editar cobertura" : `Asignar colega a ${client.honoree}`, "colFormDialog")}
    ${paid ? `<div class="col-warn">Esta cobertura ya está incluida en un pago: el colega y el monto no se pueden cambiar (deshacé el pago si hace falta).</div>` : ""}
    <div class="form-grid">
      <label>Colega<select name="colleague_id" required ${paid ? "disabled" : ""}>
        <option value="">Elegí de la lista…</option>
        ${options.map((c) => `<option value="${c.id}" data-fee="${Number(c.default_fee) || 0}" data-role="${esc(c.role || "")}" ${c.id === cv.colleague_id ? "selected" : ""}>${esc(c.name)}${c.role ? ` · ${esc(c.role)}` : ""}</option>`).join("")}
        ${coverage ? "" : `<option value="__new">＋ Agregar un colega nuevo…</option>`}
      </select></label>
      <label>Función en este evento<input name="role" maxlength="60" value="${esc(cv.role || "")}" placeholder="Fotógrafo, videógrafo…" list="colRoleList2"></label>
      <div class="col-new-fields hidden">
        <label>Nombre del colega nuevo<input name="new_name" maxlength="80" placeholder="Nombre y apellido"></label>
        <label>WhatsApp<input name="new_phone" type="tel" inputmode="tel" placeholder="Ej. 11 2345 6789"></label>
        <label>Gmail (para Drive)<input name="new_email" type="email" placeholder="nombre@gmail.com"></label>
      </div>
      <label>Hora de llegada<input name="arrival_time" type="time" value="${hhmm(cv.arrival_time)}"></label>
      <label>Hasta<input name="end_time" type="time" value="${hhmm(cv.end_time)}"></label>
      <label>Lugar / dirección<input name="location" maxlength="160" value="${esc(cv.location || "")}" placeholder="Salón o dirección"></label>
      <label>Monto a pagarle<input name="amount" type="number" min="0" step="1" inputmode="numeric" value="${cv.amount === "" ? "" : Number(cv.amount)}" ${paid ? "disabled" : ""} placeholder="Se completa con su tarifa"></label>
    </div>
    <label class="full-label">Indicaciones<textarea name="notes" rows="2" placeholder="Vestimenta, equipo, con quién se encuentra…">${esc(cv.notes || "")}</textarea></label>
    <datalist id="colRoleList2"><option>Fotógrafo</option><option>Videógrafo</option><option>Asistente</option><option>Drone</option></datalist>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">${coverage ? "Guardar" : "Asignar"}</button>
    </div>
  </form>`);
}

function onCoverageColleagueChange(select) {
  const form = select.form;
  const isNew = select.value === "__new";
  form.querySelector(".col-new-fields").classList.toggle("hidden", !isNew);
  form.elements.new_name.required = isNew;
  const opt = select.selectedOptions[0];
  if (!isNew && opt?.dataset.fee !== undefined) {
    const amount = form.elements.amount;
    if (!amount.value || amount.dataset.auto === "1") { amount.value = opt.dataset.fee || ""; amount.dataset.auto = "1"; }
    if (!form.elements.role.value && opt.dataset.role) form.elements.role.value = opt.dataset.role;
  }
}

async function saveCoverageForm(form) {
  const f = new FormData(form);
  const clientId = form.dataset.client;
  const id = form.dataset.id;
  const client = clientById(clientId);
  const existing = id ? data.coverages.find((x) => x.id === id) : null;
  let colleagueId = existing?.payment_id ? existing.colleague_id : String(f.get("colleague_id") || "");
  if (!colleagueId) { toast("Elegí un colega de la lista."); return; }
  await withBusy(form, async () => {
    if (colleagueId === "__new") {
      const name = String(f.get("new_name") || "").trim();
      const email = String(f.get("new_email") || "").trim().toLowerCase();
      if (!name) throw new Error("Poné el nombre del colega nuevo.");
      if (email && !validEmail(email)) throw new Error("Revisá el Gmail del colega nuevo.");
      const [saved] = await run(supabase.from("colleagues").insert({
        name, phone: String(f.get("new_phone") || "").trim() || null, email: email || null,
        role: String(f.get("role") || "").trim() || null, default_fee: num(f.get("amount")),
      }).select());
      data.colleagues = [...data.colleagues, saved].sort((a, b) => a.name.localeCompare(b.name));
      colleagueId = saved.id;
    }
    const row = {
      role: String(f.get("role") || "").trim() || null,
      arrival_time: f.get("arrival_time") || null,
      end_time: f.get("end_time") || null,
      location: String(f.get("location") || "").trim() || null,
      notes: String(f.get("notes") || "").trim() || null,
    };
    if (!existing?.payment_id) { row.colleague_id = colleagueId; row.amount = num(f.get("amount")); }
    let saved;
    if (existing) {
      [saved] = await run(supabase.from("colleague_coverages").update(row).eq("id", id).select());
      data.coverages = data.coverages.map((x) => (x.id === id ? saved : x));
    } else {
      [saved] = await run(supabase.from("colleague_coverages").insert({ ...row, client_id: clientId }).select());
      data.coverages = [...data.coverages, saved];
    }
    closeDialog("colFormDialog");
    refreshAll(clientId);
    // Si cambió de colega, el anterior pierde el acceso a la carpeta.
    if (existing && existing.colleague_id !== saved.colleague_id && existing.drive_shared_at) await driveRequest("unshare", { coverageId: saved.id, email: existing.drive_shared_email }).catch(() => {});
    // Acceso a Drive: se comparte solo si ya están la carpeta y el Gmail.
    const colleague = colleagueById(saved.colleague_id);
    if (saved.drive_shared_at && saved.drive_shared_email === colleague?.email) { toast("Cobertura guardada"); return; }
    if (!client?.driveUrl) { toast("Cobertura guardada. ⚠ Este evento todavía no tiene carpeta de Drive: creala con «Crear carpeta en Drive» y después tocá «Compartir Drive».", 7000); return; }
    if (!colleague?.email) { toast(`Cobertura guardada. Cargale el Gmail a ${colleague?.name || "este colega"} para compartirle la carpeta de Drive.`, 6000); return; }
    toast("Cobertura guardada. Compartiendo la carpeta de Drive…");
    await shareDrive(saved.id, { quiet: false });
  });
}

async function deleteCoverage(id) {
  const cv = data.coverages.find((x) => x.id === id); if (!cv) return;
  const c = colleagueById(cv.colleague_id);
  if (cv.payment_id) { toast("Esta cobertura ya está incluida en un pago. Para quitarla, primero deshacé el pago desde el detalle del colega.", 6000); return; }
  if (!confirm(`¿Quitar a ${c?.name || "este colega"} de este evento?`)) return;
  if (cv.drive_shared_at) await driveRequest("unshare", { coverageId: id }).catch(() => {});
  await run(supabase.from("colleague_coverages").delete().eq("id", id));
  data.coverages = data.coverages.filter((x) => x.id !== id);
  toast(cv.drive_shared_at ? "Colega quitado y sin acceso a la carpeta de Drive" : "Colega quitado del evento");
  refreshAll(cv.client_id);
}

// ── Drive ─────────────────────────────────────────────────────────────────
async function driveRequest(action, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("No hay sesión activa.");
  const res = await fetch("/api/colleague-drive-share", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "No se pudo compartir la carpeta de Drive.");
  return out;
}

async function shareDrive(coverageId) {
  const cv = data.coverages.find((x) => x.id === coverageId); if (!cv) return;
  const client = clientById(cv.client_id);
  const colleague = colleagueById(cv.colleague_id);
  if (!client?.driveUrl) { toast("⚠ Este evento todavía no tiene carpeta de Drive. Creala con «Crear carpeta en Drive» en la ficha y después compartila.", 6000); return; }
  if (!colleague?.email) { toast(`Cargale el Gmail a ${colleague?.name} para poder compartirle la carpeta.`); openColleagueForm(colleague); return; }
  if (!deps.driveAutoAvailable(client.salon)) {
    toast(`Esta carpeta no se creó desde una cuenta de Drive conectada, así que no la puedo compartir sola. Abrila y compartila con ${colleague.email} como Editor.`, 8000);
    return;
  }
  try {
    const out = await driveRequest("share", { coverageId });
    data.coverages = data.coverages.map((x) => (x.id === coverageId ? { ...x, drive_shared_at: out.sharedAt, drive_shared_email: out.email } : x));
    toast(`Listo: ${colleague.name} ya puede subir fotos a la carpeta del evento (le llegó un mail de Google).`, 5000);
  } catch (err) {
    toast(err.message, 8000);
  }
  refreshAll(cv.client_id);
}

// Se llama al crear la carpeta de Drive desde la ficha (app.js →
// createDriveFolder): comparte la carpeta nueva con los colegas que ya
// estaban asignados a ese evento y tienen Gmail cargado.
export async function shareDriveForClient(clientId) {
  if (status !== "ready") return;
  const client = clientById(clientId);
  if (!client?.driveUrl || !deps.driveAutoAvailable(client.salon)) return;
  const pending = data.coverages.filter((cv) => cv.client_id === clientId && !cv.drive_shared_at && colleagueById(cv.colleague_id)?.email);
  if (!pending.length) return;
  const names = [], failed = [];
  for (const cv of pending) {
    const colleague = colleagueById(cv.colleague_id);
    try {
      const out = await driveRequest("share", { coverageId: cv.id });
      data.coverages = data.coverages.map((x) => (x.id === cv.id ? { ...x, drive_shared_at: out.sharedAt, drive_shared_email: out.email } : x));
      names.push(firstName(colleague.name));
    } catch (err) { console.error(err); failed.push(firstName(colleague.name)); }
  }
  refreshAll(clientId);
  if (names.length) toast(`Carpeta creada y compartida con ${names.join(", ")}${failed.length ? `. No se pudo con ${failed.join(", ")}: probá «Compartir Drive»` : ""}.`, 6000);
  else if (failed.length) toast(`Carpeta creada, pero no se pudo compartir con ${failed.join(", ")}. Probá «Compartir Drive».`, 6000);
}

// ── WhatsApp ──────────────────────────────────────────────────────────────
function sendWhatsapp(colleague, text) {
  const phone = deps.whatsappNumber(colleague?.phone);
  if (!phone) { toast(`Cargale el WhatsApp a ${colleague?.name || "este colega"}.`); openColleagueForm(colleague); return; }
  deps.openWhatsappApp(`whatsapp://send/?phone=${phone}&text=${encodeURIComponent(text)}`);
}

function coverageMessage(cv) {
  const c = colleagueById(cv.colleague_id);
  const client = clientById(cv.client_id);
  const shared = cv.drive_shared_at && client?.driveUrl;
  return [
    `Hola ${firstName(c?.name)}! Te paso los datos del evento:`,
    "",
    `📅 ${dateLong(client?.eventDate)}`,
    cv.arrival_time ? `🕒 Presentarte a las ${hhmm(cv.arrival_time)} h${cv.end_time ? ` (hasta las ${hhmm(cv.end_time)} h)` : ""}` : null,
    `📍 ${cv.location || client?.salon || ""}`,
    `🎉 ${client?.honoree || ""}${client?.type ? ` (${client.type})` : ""}`,
    cv.role ? `📸 Función: ${cv.role}` : null,
    cv.notes ? `📝 ${cv.notes}` : null,
    shared ? "" : null,
    shared ? `📁 Las fotos subilas a la carpeta FOTOS de este Drive (ya te di acceso con tu Gmail):\n${client.driveUrl}` : null,
    "",
    "¡Gracias! 🙌",
  ].filter((l) => l !== null).join("\n");
}

function paymentMessage(p) {
  const c = colleagueById(p.colleague_id);
  const covers = data.coverages.filter((cv) => cv.payment_id === p.id).sort(byDate);
  const apps = data.applications.filter((a) => a.payment_id === p.id);
  const lines = [`Hola ${firstName(c?.name)}! Te pagué ${money(p.net)} (${deps.dateText(p.paid_on)}). Detalle:`, ""];
  covers.forEach((cv) => { const cl = clientById(cv.client_id); lines.push(`• ${cl ? `${deps.dateText(cl.eventDate)} ${cl.honoree}` : "Evento"}: ${money(cv.amount)}`); });
  apps.forEach((a) => {
    const d = data.discounts.find((x) => x.id === a.discount_id);
    lines.push(`• Descuento ${d ? `${d.description}${d.installments > 1 ? ` (cuota ${installmentNumber(d, p.id)}/${d.installments})` : ""}` : ""}: −${money(a.amount)}`);
  });
  lines.push("", `Total: ${money(p.net)}`);
  if (p.notes) lines.push(p.notes);
  return lines.join("\n");
}

// ── detalle del colega ────────────────────────────────────────────────────
function openColleagueDetail(id) {
  const c = colleagueById(id); if (!c) return;
  openColleagueId = id;
  const s = summary(c);
  const covers = [...s.mine].sort((a, b) => byDate(b, a));
  const discounts = data.discounts.filter((d) => d.colleague_id === id);
  const payments = data.payments.filter((p) => p.colleague_id === id).sort((a, b) => String(b.paid_on).localeCompare(String(a.paid_on)) || String(b.created_at).localeCompare(String(a.created_at)));
  const coverRow = (cv) => {
    const cl = clientById(cv.client_id);
    const st = cv.payment_id ? `<span class="col-chip ok">Pagado</span>` : isDue(cv) ? `<span class="col-chip warn">Por pagar</span>` : `<span class="col-chip">Próximo</span>`;
    return `<tr><td>${cl ? esc(deps.dateText(cl.eventDate)) : "—"}</td><td><button class="col-link" data-col="open-event" data-id="${cv.client_id}">${cl ? `${esc(cl.honoree)} <small>#${esc(cl.code)} · ${esc(cl.salon)}</small>` : "Evento borrado"}</button></td><td>${esc(cv.role || "")}</td><td>${cv.arrival_time ? `${hhmm(cv.arrival_time)} h` : ""}</td><td class="num">${money(cv.amount)}</td><td>${st}</td></tr>`;
  };
  showDialog("colDetailDialog", `<div class="col-detail">
    ${head(`${c.role || "Colega"}${c.active ? "" : " · Inactivo"}`, c.name, "colDetailDialog")}
    <div class="col-detail-top">
      <div class="col-owed ${s.net > 0 ? "has-debt" : ""}"><span>Le debés hoy</span><strong>${money(s.net)}</strong><small>${s.gross !== s.net ? `${money(s.gross)} de eventos − ${money(num(s.gross - s.net))} de cuota` : `${s.due.length} ${s.due.length === 1 ? "evento" : "eventos"} realizados sin pagar`}</small></div>
      <div class="col-detail-actions">
        <button class="primary-btn" data-col="pay" data-id="${id}">Registrar pago</button>
        <button class="secondary-btn" data-col="add-discount" data-id="${id}">+ Descuento</button>
        <button class="secondary-btn" data-col="calendar" data-id="${id}" ${c.active ? "" : "disabled"}>📅 Calendario</button>
        <button class="ghost-btn" data-col="edit-colleague" data-id="${id}">✎ Editar</button>
      </div>
    </div>
    <h3 class="col-section">Coberturas <small>${covers.length}</small></h3>
    ${covers.length ? `<div class="col-table-wrap"><table class="col-table"><thead><tr><th>Fecha</th><th>Evento</th><th>Función</th><th>Llega</th><th class="num">Monto</th><th></th></tr></thead><tbody>${covers.map(coverRow).join("")}</tbody></table></div>` : `<p class="col-empty">Todavía no tiene eventos asignados. Se asignan desde la ficha de cada evento.</p>`}
    <h3 class="col-section">Descuentos <small>${discounts.length}</small></h3>
    ${discounts.length ? `<div class="col-table-wrap"><table class="col-table"><thead><tr><th>Concepto</th><th class="num">Total</th><th>Cuotas</th><th class="num">Descontado</th><th class="num">Resta</th><th></th></tr></thead><tbody>${discounts.map((d) => { const rem = discountRemaining(d); const applied = data.applications.filter((a) => a.discount_id === d.id).length; return `<tr><td>${esc(d.description)}<small class="col-sub">${esc(deps.dateText(d.created_on))}</small></td><td class="num">${money(d.total_amount)}</td><td>${applied}/${d.installments}</td><td class="num">${money(discountApplied(d))}</td><td class="num">${rem > 0 ? money(rem) : `<span class="col-chip ok">Saldado</span>`}</td><td>${applied ? "" : `<button class="icon-btn col-mini" title="Borrar descuento" data-col="del-discount" data-id="${d.id}">×</button>`}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="col-empty">Sin descuentos. Usalos si, por ejemplo, le vendiste equipo y se lo descontás de sus trabajos.</p>`}
    <h3 class="col-section">Pagos <small>${payments.length}</small></h3>
    ${payments.length ? `<div class="col-table-wrap"><table class="col-table"><thead><tr><th>Fecha</th><th>Eventos</th><th class="num">Bruto</th><th class="num">Descuentos</th><th class="num">Pagado</th><th></th></tr></thead><tbody>${payments.map((p) => `<tr><td>${esc(deps.dateText(p.paid_on))}${p.notes ? `<small class="col-sub">${esc(p.notes)}</small>` : ""}</td><td>${data.coverages.filter((cv) => cv.payment_id === p.id).length}</td><td class="num">${money(p.gross)}</td><td class="num">${Number(p.discounts) ? `−${money(p.discounts)}` : "—"}</td><td class="num"><strong>${money(p.net)}</strong></td><td class="col-row-actions"><button class="icon-btn col-mini" title="Mandar el detalle por WhatsApp" data-col="wa-payment" data-id="${p.id}">💬</button><button class="ghost-btn col-undo" data-col="undo-payment" data-id="${p.id}">Deshacer</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="col-empty">Todavía no le registraste pagos.</p>`}
    ${c.notes ? `<p class="col-notes">📝 ${esc(c.notes)}</p>` : ""}
  </div>`);
}

// ── descuentos ────────────────────────────────────────────────────────────
function openDiscountForm(colleagueId) {
  const c = colleagueById(colleagueId); if (!c) return;
  showDialog("colFormDialog", `<form id="colDiscountForm" data-colleague="${colleagueId}">
    ${head(c.name, "Nuevo descuento", "colFormDialog")}
    <div class="form-grid">
      <label>Concepto<input name="description" required maxlength="120" placeholder="Ej. Lente 50mm que le vendí"></label>
      <label>Monto total<input name="total_amount" required type="number" min="1" step="1" inputmode="numeric" placeholder="Ej. 300000"></label>
      <label>¿En cuántas cuotas?<input name="installments" required type="number" min="1" max="60" step="1" value="1"></label>
      <label>Fecha<input name="created_on" type="date" value="${today()}"></label>
    </div>
    <p class="col-help" data-col-discount-help>Se descuenta todo en el próximo pago.</p>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">Guardar descuento</button>
    </div>
  </form>`);
}
function updateDiscountHelp(form) {
  const total = num(form.elements.total_amount.value), n = Math.max(1, Number(form.elements.installments.value) || 1);
  form.querySelector("[data-col-discount-help]").textContent = n === 1 ? "Se descuenta todo en el próximo pago." : `Se sugiere descontar ${money(num(total / n))} en cada pago (lo podés cambiar al pagar).`;
}
async function saveDiscountForm(form) {
  const f = new FormData(form);
  const row = { colleague_id: form.dataset.colleague, description: String(f.get("description") || "").trim(), total_amount: num(f.get("total_amount")), installments: Math.min(60, Math.max(1, Number(f.get("installments")) || 1)), created_on: f.get("created_on") || today() };
  if (!row.description || row.total_amount <= 0) { toast("Completá el concepto y el monto."); return; }
  await withBusy(form, async () => {
    const [saved] = await run(supabase.from("colleague_discounts").insert(row).select());
    data.discounts = [...data.discounts, saved];
    closeDialog("colFormDialog"); toast("Descuento guardado"); refreshAll();
  });
}
async function deleteDiscount(id) {
  if (!confirm("¿Borrar este descuento?")) return;
  await run(supabase.from("colleague_discounts").delete().eq("id", id));
  data.discounts = data.discounts.filter((d) => d.id !== id);
  toast("Descuento borrado"); refreshAll();
}

// ── pagos ─────────────────────────────────────────────────────────────────
function openPaymentForm(colleagueId) {
  const c = colleagueById(colleagueId); if (!c) return;
  const unpaid = data.coverages.filter((cv) => cv.colleague_id === colleagueId && !cv.payment_id).sort(byDate);
  const discounts = data.discounts.filter((d) => d.colleague_id === colleagueId && discountRemaining(d) > 0);
  if (!unpaid.length && !discounts.length) { toast(`${c.name} no tiene nada pendiente para pagar.`); return; }
  showDialog("colFormDialog", `<form id="colPaymentForm" data-colleague="${colleagueId}">
    ${head(c.name, "Registrar pago", "colFormDialog")}
    ${unpaid.length ? `<p class="col-label">Eventos que le pagás <small>(los futuros vienen sin marcar)</small></p>
    <div class="col-pay-list">${unpaid.map((cv) => { const cl = clientById(cv.client_id); return `<label class="col-pay-item"><input type="checkbox" name="coverage" value="${cv.id}" data-amount="${Number(cv.amount)}" ${isDue(cv) ? "checked" : ""}><span>${cl ? `${esc(deps.dateText(cl.eventDate))} · ${esc(cl.honoree)}` : "Evento"}${isDue(cv) ? "" : ` <em>· próximo</em>`}</span><strong>${money(cv.amount)}</strong></label>`; }).join("")}</div>` : ""}
    ${discounts.length ? `<p class="col-label">Descuentos de este pago</p>
    <div class="col-pay-list">${discounts.map((d) => `<label class="col-pay-item col-pay-disc"><span>${esc(d.description)} <em>· resta ${money(discountRemaining(d))}${d.installments > 1 ? ` · cuota sugerida ${money(suggestedInstallment(d))}` : ""}</em></span><input type="number" name="discount" data-id="${d.id}" min="0" max="${discountRemaining(d)}" step="1" value="${suggestedInstallment(d)}"></label>`).join("")}</div>` : ""}
    <div class="form-grid col-pay-meta">
      <label>Fecha del pago<input name="paid_on" type="date" value="${today()}" required></label>
      <label>Nota (opcional)<input name="notes" maxlength="140" placeholder="Ej. Transferencia"></label>
    </div>
    <div class="col-pay-total"><div><span>Eventos</span><strong data-col-pay="gross">$ 0</strong></div><div><span>Descuentos</span><strong data-col-pay="disc">$ 0</strong></div><div class="col-pay-net"><span>A pagar</span><strong data-col-pay="net">$ 0</strong></div></div>
    <p class="col-help col-error hidden" data-col-pay="error"></p>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">Registrar pago</button>
    </div>
  </form>`);
  updatePaymentTotals(document.getElementById("colPaymentForm"));
}
function paymentValues(form) {
  const coverageIds = [...form.querySelectorAll("input[name=coverage]:checked")].map((i) => i.value);
  const gross = num([...form.querySelectorAll("input[name=coverage]:checked")].reduce((s, i) => s + Number(i.dataset.amount), 0));
  const discounts = [...form.querySelectorAll("input[name=discount]")].map((i) => ({ id: i.dataset.id, amount: num(i.value), max: Number(i.max) })).filter((d) => d.amount > 0);
  const disc = num(discounts.reduce((s, d) => s + d.amount, 0));
  let error = "";
  if (discounts.some((d) => d.amount > d.max)) error = "Un descuento supera lo que queda por descontar.";
  else if (disc > gross) error = "Los descuentos no pueden superar lo que le pagás en este pago.";
  else if (!coverageIds.length && !disc) error = "Marcá al menos un evento.";
  return { coverageIds, gross, disc, net: num(gross - disc), discounts: discounts.map(({ id, amount }) => ({ id, amount })), error };
}
function updatePaymentTotals(form) {
  const v = paymentValues(form);
  form.querySelector("[data-col-pay=gross]").textContent = money(v.gross);
  form.querySelector("[data-col-pay=disc]").textContent = v.disc ? `−${money(v.disc)}` : money(0);
  form.querySelector("[data-col-pay=net]").textContent = money(Math.max(0, v.net));
  const err = form.querySelector("[data-col-pay=error]");
  err.textContent = v.error; err.classList.toggle("hidden", !v.error || v.error.startsWith("Marcá"));
}
async function savePaymentForm(form) {
  const v = paymentValues(form);
  if (v.error) { toast(v.error); return; }
  const colleagueId = form.dataset.colleague;
  await withBusy(form, async () => {
    const paymentId = await run(supabase.rpc("register_colleague_payment", {
      p_colleague_id: colleagueId, p_coverage_ids: v.coverageIds, p_discounts: v.discounts,
      p_paid_on: form.elements.paid_on.value || today(), p_notes: form.elements.notes.value || null,
    }));
    closeDialog("colFormDialog");
    await loadColleagues();
    const p = data.payments.find((x) => x.id === paymentId);
    toast(`Pago registrado: ${money(v.net)}`);
    if (p && colleagueById(colleagueId)?.phone && confirm("Pago registrado. ¿Le mandás el detalle por WhatsApp?")) sendWhatsapp(colleagueById(colleagueId), paymentMessage(p));
  });
}
async function undoPayment(id) {
  const p = data.payments.find((x) => x.id === id); if (!p) return;
  if (!confirm(`¿Deshacer el pago del ${deps.dateText(p.paid_on)} por ${money(p.net)}?\n\nLos eventos vuelven a quedar pendientes y las cuotas de descuento de ese pago se anulan.`)) return;
  await run(supabase.from("colleague_payments").delete().eq("id", id));
  toast("Pago deshecho");
  await loadColleagues();
}

// ── calendario ────────────────────────────────────────────────────────────
function calendarUrl(c) { return `${PRODUCTION_ORIGIN}/api/colleague-calendar?token=${c.calendar_token}`; }
function calendarPageUrl(c) { return `${calendarUrl(c)}&page=1`; }
function calendarMessage(c) {
  return [
    `Hola ${firstName(c.name)}! Te comparto tu calendario de coberturas: ahí vas a tener siempre los eventos que cubrís conmigo, con día, hora de llegada, lugar y la carpeta de Drive para subir las fotos.`,
    "",
    "Abrí este link y tocá el botón para agregarlo a tu calendario (iPhone o Google Calendar). Se actualiza solo:",
    calendarPageUrl(c),
    "",
    "Es personal, no lo compartas 🙌",
  ].join("\n");
}
function openCalendarDialog(id) {
  const c = colleagueById(id); if (!c) return;
  showDialog("colFormDialog", `<div class="col-cal">
    ${head(c.name, "Calendario de coberturas", "colFormDialog")}
    <p class="col-help">Es un link privado: ${esc(firstName(c.name))} ve solo sus eventos (día, hora, lugar y carpeta de Drive), sin montos ni datos de contacto del cliente. Lo agrega una vez y se actualiza solo.</p>
    <label class="full-label">Link para mandarle<input readonly value="${esc(calendarPageUrl(c))}" data-col-cal-link></label>
    <div class="modal-actions col-cal-actions">
      <button class="ghost-btn" type="button" data-col="cal-regen" data-id="${c.id}" title="El link anterior deja de funcionar">Generar link nuevo</button>
      <button class="secondary-btn" type="button" data-col="cal-copy">Copiar</button>
      <a class="secondary-btn" href="${esc(calendarPageUrl(c))}" target="_blank" rel="noopener">Ver página</a>
      <button class="primary-btn" type="button" data-col="cal-wa" data-id="${c.id}">💬 Mandar por WhatsApp</button>
    </div>
  </div>`);
}
async function regenerateCalendar(id) {
  if (!confirm("¿Generar un link nuevo? El link anterior deja de funcionar y vas a tener que mandarle el nuevo.")) return;
  const token = await run(supabase.rpc("regenerate_colleague_calendar_token", { p_colleague_id: id }));
  data.colleagues = data.colleagues.map((c) => (c.id === id ? { ...c, calendar_token: token } : c));
  openCalendarDialog(id);
  toast("Link nuevo generado");
}

// ── eventos ───────────────────────────────────────────────────────────────
async function withBusy(form, fn) {
  const btns = [...form.querySelectorAll("button")];
  btns.forEach((b) => (b.disabled = true));
  try { await fn(); } catch (err) { console.error(err); toast(friendlyError(err), 6000); } finally { btns.forEach((b) => (b.disabled = false)); }
}

const ACTIONS = {
  reload: () => loadColleagues(),
  close: (id) => closeDialog(id),
  "new-colleague": () => openColleagueForm(null),
  "edit-colleague": (id) => openColleagueForm(colleagueById(id)),
  "del-colleague": (id) => deleteColleague(id),
  "open-colleague": (id) => openColleagueDetail(id),
  pay: (id) => openPaymentForm(id),
  "add-discount": (id) => openDiscountForm(id),
  "del-discount": (id) => deleteDiscount(id),
  "undo-payment": (id) => undoPayment(id),
  "wa-payment": (id) => { const p = data.payments.find((x) => x.id === id); if (p) sendWhatsapp(colleagueById(p.colleague_id), paymentMessage(p)); },
  calendar: (id) => openCalendarDialog(id),
  "cal-copy": async () => { const v = document.querySelector("[data-col-cal-link]")?.value; try { await navigator.clipboard.writeText(v); toast("Link copiado"); } catch { toast("No se pudo copiar: seleccionalo y copialo a mano"); } },
  "cal-wa": (id) => { const c = colleagueById(id); if (c) sendWhatsapp(c, calendarMessage(c)); },
  "cal-regen": (id) => regenerateCalendar(id),
  assign: (clientId) => { if (status !== "ready") { toast("Esperá que terminen de cargar los colegas."); return; } openCoverageForm(clientId, null); },
  "edit-coverage": (id) => { const cv = data.coverages.find((x) => x.id === id); if (cv) openCoverageForm(cv.client_id, cv); },
  "del-coverage": (id) => deleteCoverage(id),
  "wa-coverage": (id) => { const cv = data.coverages.find((x) => x.id === id); if (cv) sendWhatsapp(colleagueById(cv.colleague_id), coverageMessage(cv)); },
  "share-drive": (id) => shareDrive(id),
  "open-event": (clientId) => { if (!clientById(clientId)) return; closeDialog("colDetailDialog"); deps.openClientDetail(clientId); },
};

export function initColleagues(dependencies) {
  deps = dependencies;
  ensureDialogs();
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-col]");
    if (!el || el.disabled) return;
    const action = ACTIONS[el.dataset.col];
    if (!action) return;
    e.preventDefault(); e.stopPropagation();
    Promise.resolve(action(el.dataset.id)).catch((err) => { console.error(err); toast(friendlyError(err), 6000); });
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-col-toggle-inactive]")) { showInactive = e.target.checked; renderColleagues(); }
    if (e.target.matches("#colCoverageForm select[name=colleague_id]")) onCoverageColleagueChange(e.target);
  });
  document.addEventListener("input", (e) => {
    const form = e.target.form;
    if (form?.id === "colPaymentForm") updatePaymentTotals(form);
    if (form?.id === "colDiscountForm") updateDiscountHelp(form);
    if (form?.id === "colCoverageForm" && e.target.name === "amount") e.target.dataset.auto = "0";
  });
  document.addEventListener("submit", (e) => {
    const handlers = { colColleagueForm: saveColleagueForm, colCoverageForm: saveCoverageForm, colDiscountForm: saveDiscountForm, colPaymentForm: savePaymentForm };
    const handler = handlers[e.target.id];
    if (!handler) return;
    e.preventDefault();
    handler(e.target);
  });
}
