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
import { cloudEnabled, supabase, supabaseUrl } from "./cloud.js";

const PRODUCTION_ORIGIN = "https://janos-control.vercel.app";

let deps = null;
let data = emptyData();
let status = "idle"; // idle | loading | ready | error
let loadError = "";
let showInactive = false;
// Equipos: comparten la cuenta, pero cada jefe maneja y le paga a su gente.
const DEFAULT_TEAMS = ["Pablo", "Dylan", "Gustavo"];
// Personal ajeno que cubre algún evento suelto: queda registrado como colega
// de este grupo y la cobertura guarda qué equipo lo asignó (cv.team).
const EXTERNAL_TEAM = "Externos";
function teamLabel(t) { return t === EXTERNAL_TEAM ? "Externos" : `Equipo ${t}`; }
function isExternal(c) { return teamOf(c) === EXTERNAL_TEAM; }
const TEAM_KEY = "janos_colegas_team";
let teamFilter = (() => { try { return localStorage.getItem(TEAM_KEY) || ""; } catch { return ""; } })();
function teamOf(c) { return String(c?.team || "Pablo"); }
function allTeams() { return [...new Set([...DEFAULT_TEAMS, ...data.colleagues.map(teamOf)])]; }
// Cada jefe (Pablo / Dylan / Gustavo) tiene su panel: ve su personal y los
// externos que asignó él (coberturas con cv.team de su equipo).
function panelTeams() { return [...new Set([...DEFAULT_TEAMS, ...data.colleagues.map(teamOf).filter((t) => t !== EXTERNAL_TEAM)])]; }
function currentPanel() { return panelTeams().includes(teamFilter) ? teamFilter : "Pablo"; }
function inTeam(c) {
  const team = currentPanel();
  if (teamOf(c) === team) return true;
  return isExternal(c) && data.coverages.some((cv) => cv.colleague_id === c.id && (cv.team || "Pablo") === team);
}
// Modo de la vista: "team" (personal y pagos) | "assign" (repartir eventos).
const MODE_KEY = "janos_colegas_mode";
let colMode = (() => { try { return localStorage.getItem(MODE_KEY) === "assign" ? "assign" : "team"; } catch { return "team"; } })();
let assignMonth = "", assignSalon = "", assignOnlyFree = false;
let assignKind = "event"; // "event" | "session" (sesiones de fotos)
let assignWhen = "upcoming"; // "upcoming" | "past" (trabajos que ya pasaron, para cargarlos y pagarlos)
// Sesiones de fotos leídas de Google Calendar (ahí se agendan: título
// "#código Book Nombre · lugar · hora"). null = todavía no se cargaron.
let gcalSessions = null; // { status: "loading" | "ready" | "not_connected" | "error", events: [] }
let sessionInfo = new Map(); // clientId → { date, time, location, source }
let openColleagueId = null;
// Hora de inicio de cada evento (clients.event_time). La app principal no la
// usa ni la pisa al guardar (no está entre las columnas que sincroniza).
let eventTimes = new Map();
const ARRIVAL_BEFORE_MIN = 90; // el personal se presenta 90 minutos antes
function eventTimeOf(clientId) { return eventTimes.get(clientId) || ""; }
function minusMinutes(hm, mins) {
  const [h, m] = String(hm).split(":").map(Number);
  const t = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
function suggestedArrival(clientId) { const t = eventTimeOf(clientId); return t ? minusMinutes(t, ARRIVAL_BEFORE_MIN) : ""; }

function emptyData() { return { colleagues: [], coverages: [], payments: [], discounts: [], applications: [], notes: [], marks: [], unavail: [] }; }
// Días que la persona marcó "No puedo" en su portal.
function unavailableOn(colleagueId, day) { return data.unavail.find((u) => u.colleague_id === colleagueId && u.day === day) || null; }

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
function coverageDate(cv) { return cv.work_date || clientById(cv.client_id)?.eventDate || ""; }
function isSession(cv) { return cv?.kind === "session"; }
function kindTag(cv) { return isSession(cv) ? "Sesión de fotos" : "Evento"; }
// Sesión de fotos cargada en la ficha del cliente (app.js → client.photoSession).
function photoSessionOf(client) { const ps = client?.photoSession; return ps && ps.date ? ps : null; }
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
// Lo dado "a cuenta" (pagos parciales) que todavía no se descontó de un pago de eventos.
function advanceCredit(colleagueId) {
  return num(data.payments.filter((p) => p.colleague_id === colleagueId).reduce((s, p) => s + (p.kind === "advance" ? Number(p.net) : 0) - Number(p.advance_used || 0), 0));
}
function summary(colleague) {
  const mine = data.coverages.filter((cv) => cv.colleague_id === colleague.id);
  const unpaid = mine.filter((cv) => !cv.payment_id);
  const due = unpaid.filter(isDue);
  const gross = num(due.reduce((s, cv) => s + Number(cv.amount), 0));
  const discounts = data.discounts.filter((d) => d.colleague_id === colleague.id && discountRemaining(d) > 0);
  const nextCuotas = num(discounts.reduce((s, d) => s + suggestedInstallment(d), 0));
  const upcoming = mine.filter((cv) => coverageDate(cv) >= today()).sort(byDate);
  const credit = advanceCredit(colleague.id);
  const afterCuotas = num(Math.max(0, gross - Math.min(gross, nextCuotas)));
  return {
    mine, unpaid, due, gross, credit, afterCuotas,
    net: num(Math.max(0, afterCuotas - credit)),
    future: num(unpaid.filter((cv) => !isDue(cv)).reduce((s, cv) => s + Number(cv.amount), 0)),
    discountLeft: num(discounts.reduce((s, d) => s + discountRemaining(d), 0)),
    next: upcoming[0] || null,
  };
}

function owedDetail(s) {
  const parts = [];
  if (s.due.length) parts.push(`${s.due.length} ${s.due.length === 1 ? "evento" : "eventos"} sin pagar (${money(s.gross)})`);
  if (s.gross !== s.afterCuotas) parts.push(`− ${money(num(s.gross - s.afterCuotas))} de cuota`);
  if (s.credit > 0) parts.push(s.net > 0 || s.gross ? `− ${money(Math.min(s.credit, s.afterCuotas))} ya dado a cuenta` : `${money(s.credit)} dado a cuenta`);
  if (s.credit > s.afterCuotas && s.afterCuotas > 0) parts.push(`le queda a favor ${money(num(s.credit - s.afterCuotas))}`);
  return parts.length ? parts.join(" · ") : "Está al día";
}

// ── carga ─────────────────────────────────────────────────────────────────
export async function loadColleagues() {
  if (!cloudEnabled || !deps?.isSignedIn()) return;
  status = "loading"; loadError = "";
  try {
    const [colleagues, coverages, payments, discounts, applications, notes, marks] = await Promise.all([
      fetchAll("colleagues", "name"),
      fetchAll("colleague_coverages", "created_at"),
      fetchAll("colleague_payments", "paid_on"),
      fetchAll("colleague_discounts", "created_on"),
      fetchAll("colleague_discount_applications", "created_at"),
      fetchAll("colleague_notes", "created_at"),
      // colleague_task_marks no tiene columna id (la clave es task_id).
      run(supabase.from("colleague_task_marks").select("*").order("done_at").limit(5000)),
    ]);
    const times = await run(supabase.from("clients").select("id,event_time").not("event_time", "is", null).limit(5000));
    const unavail = await fetchAll("colleague_unavailability", "day");
    eventTimes = new Map((times || []).map((r) => [r.id, hhmm(r.event_time)]));
    data = { colleagues, coverages, payments, discounts, applications, notes: notes || [], marks: marks || [], unavail: unavail || [] };
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
// El selector vive en el encabezado de la app (junto a #viewTitle); el CSS lo
// muestra solo cuando la vista Colegas está activa.
function headerPicker(html) {
  let el = document.getElementById("colHeaderPick");
  if (!el) {
    const titleBlock = document.getElementById("viewTitle")?.parentElement;
    if (!titleBlock) return;
    el = document.createElement("div");
    el.id = "colHeaderPick";
    el.className = "col-header-pick";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Panel de");
    titleBlock.after(el);
  }
  el.innerHTML = html;
}
export function renderColleagues() {
  const root = document.getElementById("colleaguesView");
  if (!root || !deps) return;
  if (!cloudEnabled || !deps.isSignedIn()) { root.innerHTML = `<div class="panel"><div class="empty"><strong>Colegas</strong>Iniciá sesión para llevar el control de tu equipo.</div></div>`; return; }
  if (status !== "ready") headerPicker("");
  if (status === "loading" || status === "idle") { root.innerHTML = `<div class="panel"><div class="empty">Cargando colegas…</div></div>`; return; }
  if (status === "error") { root.innerHTML = `<div class="panel"><div class="empty"><strong>No se pudieron cargar los colegas</strong>${esc(loadError)}<br><br><button class="secondary-btn" data-col="reload">Reintentar</button></div></div>`; return; }

  teamFilter = currentPanel();
  const teamColleagues = data.colleagues.filter(inTeam);
  const teamIds = new Set(teamColleagues.map((c) => c.id));
  const list = teamColleagues.filter((c) => showInactive || c.active);
  const sums = teamColleagues.filter((c) => c.active).map(summary);
  const totalOwed = num(sums.reduce((s, x) => s + x.net, 0));
  const upcomingCount = data.coverages.filter((cv) => teamIds.has(cv.colleague_id) && coverageDate(cv) >= today()).length;
  const discountLeft = num(sums.reduce((s, x) => s + x.discountLeft, 0));
  const inactiveCount = teamColleagues.filter((c) => !c.active).length;
  // Selector "Panel de" en el encabezado, al lado del título "Colegas".
  headerPicker(`<span>Panel de</span>${panelTeams().map((t) => `<button class="col-panel-btn ${teamFilter === t ? "active" : ""}" aria-pressed="${teamFilter === t}" data-col="team" data-id="${esc(t)}"><i aria-hidden="true">${esc(t.charAt(0).toUpperCase())}</i>${esc(t)}</button>`).join("")}`);
  const teamTabs = "";

  const modeTabs = `<div class="view-switch col-modes" aria-label="Sección">
    <button class="${colMode === "team" ? "active" : ""}" aria-pressed="${colMode === "team"}" data-col="mode" data-id="team">👥 Personal y pagos</button>
    <button class="${colMode === "assign" ? "active" : ""}" aria-pressed="${colMode === "assign"}" data-col="mode" data-id="assign">📋 Repartir eventos</button>
  </div>`;
  if (colMode === "assign") { root.innerHTML = `${teamTabs}${modeTabs}${replacementsHtml()}${distributorHtml()}`; return; }
  root.innerHTML = `
    ${teamTabs}
    ${modeTabs}
    ${replacementsHtml()}
    <div class="col-toolbar">
      <div class="col-stats">
        <div class="col-stat col-stat-gold"><span>${esc(teamFilter)} les debe</span><strong>${money(totalOwed)}</strong><small>eventos ya realizados, con cuotas descontadas</small></div>
        <div class="col-stat"><span>Coberturas próximas</span><strong>${upcomingCount}</strong><small>de hoy en adelante</small></div>
        <div class="col-stat"><span>Descuentos por cobrar</span><strong>${money(discountLeft)}</strong><small>equipos u otros adelantos</small></div>
      </div>
      <div class="col-toolbar-actions">
        ${inactiveCount ? `<label class="col-toggle"><input type="checkbox" data-col-toggle-inactive ${showInactive ? "checked" : ""}> Ver inactivos (${inactiveCount})</label>` : ""}
        <button class="primary-btn" data-col="new-colleague">+ Agregar colega</button>
      </div>
    </div>
    ${list.length ? "" : `<div class="panel"><div class="empty"><strong>${esc(teamFilter)} todavía no tiene personal cargado</strong>Agregalo con «+ Agregar colega».</div></div>`}
    ${!list.length ? "" : list.length ? `<div class="col-grid">${list.map(cardHtml).join("")}</div>` : `<div class="panel"><div class="empty"><strong>Todavía no cargaste colegas</strong>Agregá a las personas que cubren tus eventos con su tarifa, WhatsApp y Gmail.<br><br><button class="primary-btn" data-col="new-colleague">+ Agregar el primero</button></div></div>`}`;
}

function cardHtml(c) {
  const s = summary(c);
  const nextClient = s.next ? clientById(s.next.client_id) : null;
  return `<article class="col-card ${c.active ? "" : "inactive"}">
    <header class="col-card-head">
      <div class="col-avatar">${esc(firstName(c.name).charAt(0).toUpperCase() || "?")}</div>
      <div class="col-card-name"><strong>${esc(c.name)}</strong><span>${esc(teamLabel(teamOf(c)))} · ${esc(c.role || "Sin función")}${c.active ? "" : " · Inactivo"}</span></div>
      <button class="icon-btn col-edit" title="Editar colega" data-col="edit-colleague" data-id="${c.id}">✎</button>
    </header>
    <div class="col-owed ${s.net > 0 ? "has-debt" : ""}"><span>Le debés</span><strong>${money(s.net)}</strong><small>${owedDetail(s)}</small></div>
    <dl class="col-facts">
      <div><dt>Próxima cobertura</dt><dd>${nextClient ? `${esc(deps.dateText(coverageDate(s.next)))} · ${isSession(s.next) ? "Sesión · " : ""}${esc(nextClient.honoree)}` : "—"}</dd></div>
      <div><dt>A futuro</dt><dd>${money(s.future)}</dd></div>
      <div><dt>Descuentos pendientes</dt><dd>${money(s.discountLeft)}</dd></div>
      <div><dt>Tarifa</dt><dd>${money(c.default_fee)}</dd></div>
    </dl>
    <div class="col-card-contact">${c.phone ? `<span>📱 ${esc(c.phone)}</span>` : `<span class="col-missing">Sin WhatsApp</span>`}${c.email ? `<span>✉ ${esc(c.email)}</span>` : `<span class="col-missing">Sin Gmail (para Drive)</span>`}</div>
    <div class="col-card-portal">${(c.salons || []).length ? `<span class="col-chip">🏛 ${esc(c.salons.join(", "))}</span>` : `<span class="col-chip warn">Sin salón asignado</span>`}${c.user_id ? `<button class="col-chip ok" data-col="access" data-id="${c.id}" title="Ver o cambiar su acceso">🔑 Con acceso al portal</button>` : `<button class="col-chip action" data-col="access" data-id="${c.id}" ${c.active ? "" : "disabled"}>🔑 Darle acceso al portal</button>`}</div>
    <footer class="col-card-actions">
      <button class="secondary-btn" data-col="open-colleague" data-id="${c.id}">Ver detalle</button>
      <button class="secondary-btn" data-col="calendar" data-id="${c.id}" ${c.active ? "" : "disabled"}>📅 Calendario</button>
      <button class="primary-btn" data-col="pay" data-id="${c.id}">Registrar pago</button>
    </footer>
  </article>`;
}

// Guarda la hora de inicio del evento y acomoda la llegada del personal que
// no tenía horario (o tenía el calculado con la hora anterior).
async function setEventTime(clientId, value) {
  const prevArrival = suggestedArrival(clientId);
  await run(supabase.from("clients").update({ event_time: value || null }).eq("id", clientId).select("id"));
  if (value) eventTimes.set(clientId, value); else eventTimes.delete(clientId);
  if (!value) return [];
  const arrival = minusMinutes(value, ARRIVAL_BEFORE_MIN);
  const fixed = [];
  for (const cv of data.coverages.filter((x) => x.client_id === clientId && (x.kind || "event") === "event" && (!x.arrival_time || hhmm(x.arrival_time) === prevArrival) && hhmm(x.arrival_time) !== arrival)) {
    const [saved] = await run(supabase.from("colleague_coverages").update({ arrival_time: arrival }).eq("id", cv.id).select());
    if (saved) { data.coverages = data.coverages.map((x) => (x.id === cv.id ? saved : x)); fixed.push(saved); }
  }
  return fixed;
}
async function onEventTimeInput(input) {
  const clientId = input.dataset.colEventTime;
  const client = clientById(clientId);
  input.disabled = true;
  try {
    const fixed = await setEventTime(clientId, input.value);
    toast(input.value ? `Inicio ${input.value} h · el personal llega ${minusMinutes(input.value, ARRIVAL_BEFORE_MIN)} h` : "Horario borrado");
    for (const cv of fixed) await notifyChange({ client, cv, changed: colleagueById(cv.colleague_id), offerWa: fixed.length === 1 });
  } catch (err) { console.error(err); toast(friendlyError(err), 6000); }
  refreshAll();
}

// ── pedidos de reemplazo (la persona marcó "No puedo" un día que tenía trabajo) ──
function replacementsHtml() {
  const team = currentPanel();
  const list = data.coverages.filter((cv) => cv.replacement_requested_at && !cv.payment_id && coverageDate(cv) >= today() && inTeamCoverage(cv, team))
    .sort((a, b) => coverageDate(a).localeCompare(coverageDate(b)));
  if (!list.length) return "";
  const people = data.colleagues.filter((c) => c.active && (teamOf(c) === team || isExternal(c))).sort((a, b) => (isExternal(a) - isExternal(b)) || a.name.localeCompare(b.name));
  return `<section class="col-repl" aria-label="Pedidos de reemplazo">
    <h3>⚠ ${list.length === 1 ? "1 pedido de reemplazo" : `${list.length} pedidos de reemplazo`}</h3>
    ${list.map((cv) => {
      const who = colleagueById(cv.colleague_id), cl = clientById(cv.client_id), day = coverageDate(cv);
      const opts = people.filter((p) => p.id !== cv.colleague_id).map((p) => {
        const off = unavailableOn(p.id, day);
        const busy = data.coverages.some((x) => x.colleague_id === p.id && x.id !== cv.id && coverageDate(x) === day);
        return `<option value="${p.id}" ${off ? "disabled" : ""}>${esc(p.name)}${isExternal(p) ? " (externo)" : ""}${off ? " · 🚫 no disponible" : busy ? " · ya tiene otro trabajo" : ""}</option>`;
      }).join("");
      return `<div class="col-repl-row">
        <div><strong>${esc(deps.dateText(day))} · ${isSession(cv) ? "📷 Sesión · " : ""}${esc(cl?.honoree || "Evento")}</strong>
          <span>${esc(who?.name || "Colega")} no puede${cv.replacement_reason ? ` · «${esc(cv.replacement_reason)}»` : ""} · ${esc(cl?.salon || "")}</span></div>
        <div class="col-repl-act">
          <select data-col-replace="${cv.id}" aria-label="Elegir reemplazo"><option value="">Elegir reemplazo…</option>${opts}<option value="__ext">＋ Persona externa…</option></select>
          <button class="ghost-btn col-mini-btn" data-col="repl-keep" data-id="${cv.id}" title="Descarta el pedido y la deja asignada">Mantener</button>
        </div>
      </div>`;
    }).join("")}
  </section>`;
}
function inTeamCoverage(cv, team) {
  const c = colleagueById(cv.colleague_id);
  return isExternal(c) ? (cv.team || "Pablo") === team : teamOf(c) === team;
}
async function replaceCoverage(cvId, newId) {
  const cv = data.coverages.find((x) => x.id === cvId); if (!cv || !newId) return;
  const client = clientById(cv.client_id);
  const prev = colleagueById(cv.colleague_id), person = colleagueById(newId);
  try {
    if (data.coverages.some((x) => x.client_id === cv.client_id && x.colleague_id === newId && (x.kind || "event") === (cv.kind || "event"))) throw new Error("Esa persona ya está asignada a ese trabajo.");
    if (cv.drive_shared_at) await driveRequest("unshare", { coverageId: cv.id }).catch(() => {});
    const [saved] = await run(supabase.from("colleague_coverages").update({
      colleague_id: newId, team: inTeamCoverage(cv, currentPanel()) ? currentPanel() : cv.team, amount: num(person?.default_fee), role: person?.role || cv.role || null,
      drive_shared_at: null, drive_shared_email: null, replacement_requested_at: null, replacement_reason: null,
    }).eq("id", cvId).select());
    data.coverages = data.coverages.map((x) => (x.id === cvId ? saved : x));
    toast(`Reemplazo: ${person?.name} cubre ${client?.honoree || "el trabajo"}`);
    await notifyChange({ client, cv: saved, added: person, removed: prev });
    if (client?.driveUrl && person?.email && deps.driveAutoAvailable(client.salon)) await shareDrive(saved.id).catch(() => {});
  } catch (err) { console.error(err); toast(friendlyError(err), 6000); }
  refreshAll(cv.client_id);
}
async function keepCoverage(cvId) {
  const [saved] = await run(supabase.from("colleague_coverages").update({ replacement_requested_at: null, replacement_reason: null }).eq("id", cvId).select());
  data.coverages = data.coverages.map((x) => (x.id === cvId ? saved : x));
  toast("Pedido descartado: sigue asignada");
  refreshAll();
}

// ── repartir eventos: un selector por evento para elegir quién lo cubre ──
// Cada equipo reparte lo suyo: el selector muestra solo su personal y la
// cobertura del evento de ese equipo (si ya hay una, la cambia o la quita).
function assignTeam() { return currentPanel(); }
function teamCoverages(clientId, team, kind = "event") {
  return data.coverages.filter((cv) => {
    if (cv.client_id !== clientId || (cv.kind || "event") !== kind) return false;
    const c = colleagueById(cv.colleague_id);
    return isExternal(c) ? (cv.team || "Pablo") === team : teamOf(c) === team;
  });
}
async function loadGcalSessions() {
  if (gcalSessions?.status !== "loading") { gcalSessions = { status: "loading", events: [] }; renderColleagues(); }
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Volvé a iniciar sesión.");
    const months = [];
    const d = new Date(); d.setDate(1);
    for (let i = 0; i < 7; i++) { months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); d.setMonth(d.getMonth() + 1); }
    const results = await Promise.all(months.map(async (m) => {
      const res = await fetch(`${supabaseUrl}/functions/v1/google-calendar-events?month=${m}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      return res.json().catch(() => ({}));
    }));
    if (results.some((r) => r.error === "not_connected")) { gcalSessions = { status: "not_connected", events: [] }; }
    else {
      const err = results.find((r) => r.error);
      gcalSessions = { status: err && !results.some((r) => r.events) ? "error" : "ready", error: err?.error || "", events: results.flatMap((r) => r.events || []) };
    }
  } catch (err) {
    console.error(err);
    gcalSessions = { status: "error", error: String(err.message || err), events: [] };
  }
  renderColleagues();
}
// "#123 Book Sofía · Maschwitz · 12:00" → código 123 (también lo busca en la descripción).
function isGcalSession(e) { return /\bbook\b|sesi[oó]n/i.test(e.title || ""); }
function gcalSessionCode(e) {
  const m = `${e.title || ""}\n${e.description || ""}`.match(/#\s*([A-Za-z0-9-]+)/);
  return m ? m[1] : "";
}
function buildSessionItems() {
  const today0 = today();
  const byCode = new Map(deps.getClients().map((c) => [String(c.code), c]));
  const items = new Map();
  const unmatched = [];
  for (const e of gcalSessions?.events || []) {
    if (!e.date || e.date < today0) continue;
    if (!isGcalSession(e)) continue;
    const client = byCode.get(gcalSessionCode(e));
    if (!client) { unmatched.push(e); continue; }
    if (!items.has(client.id)) items.set(client.id, { client, date: e.date, time: e.time || "", location: e.location || photoSessionOf(client)?.location || "", source: "gcal" });
  }
  for (const client of deps.getClients()) {
    const ps = photoSessionOf(client);
    if (!ps || ps.date < today0 || items.has(client.id)) continue;
    items.set(client.id, { client, date: ps.date, time: ps.time || "", location: ps.location || "", source: "ficha" });
  }
  sessionInfo = new Map([...items].map(([id, it]) => [id, it]));
  return { items: [...items.values()], unmatched };
}

function distributorHtml() {
  const team = assignTeam();
  const kind = assignKind;
  const people = data.colleagues.filter((c) => c.active && teamOf(c) === team).sort((a, b) => a.name.localeCompare(b.name));
  if (kind === "session" && gcalSessions === null) { gcalSessions = { status: "loading", events: [] }; setTimeout(loadGcalSessions); }
  let all = [];
  let unmatched = [];
  if (kind === "session") {
    const built = buildSessionItems();
    unmatched = built.unmatched;
    all = built.items.map((it) => ({ ...it, key: it.client.id }));
  } else {
    const yearAgo = (() => { const x = new Date(`${today()}T12:00:00`); x.setFullYear(x.getFullYear() - 1); return x.toISOString().slice(0, 10); })();
    all = deps.getClients()
      .filter((c) => c.eventDate && (assignWhen === "past" ? c.eventDate < today() && c.eventDate >= yearAgo : c.eventDate >= today()))
      .map((c) => ({ client: c, date: c.eventDate, time: eventTimeOf(c.id), key: c.id }));
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || "").localeCompare(String(b.time || "")) || String(a.client.honoree).localeCompare(String(b.client.honoree)));
  const past = kind === "event" && assignWhen === "past";
  if (past) all.reverse();
  const months = [...new Set(all.map((it) => it.date.slice(0, 7)))];
  const salons = [...new Set(all.map((it) => it.client.salon).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (assignMonth && !months.includes(assignMonth)) assignMonth = "";
  if (assignSalon && !salons.includes(assignSalon)) assignSalon = "";
  const rows = all
    .filter((it) => !assignMonth || it.date.startsWith(assignMonth))
    .filter((it) => !assignSalon || it.client.salon === assignSalon)
    .filter((it) => !assignOnlyFree || !teamCoverages(it.client.id, team, kind).length);
  // Quién ya trabaja cada día (para avisar si se superpone).
  const busy = new Map();
  data.coverages.forEach((cv) => { const d = coverageDate(cv); if (!busy.has(d)) busy.set(d, new Map()); busy.get(d).set(cv.colleague_id, `${cv.client_id}:${cv.kind || "event"}`); });
  const counts = new Map(people.map((p) => [p.id, 0]));
  let free = 0;
  rows.forEach((it) => { const cvs = teamCoverages(it.client.id, team, kind); if (!cvs.length) free++; cvs.forEach((cv) => counts.set(cv.colleague_id, (counts.get(cv.colleague_id) || 0) + 1)); });
  const monthName = (m) => { const t = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(new Date(`${m}-15T12:00:00`)); return t.charAt(0).toUpperCase() + t.slice(1); };
  const packName = (p) => ({ silver: "Silver", gold: "Golden", vip: "VIP", informal: "Informal" })[p] || p || "";
  const word = kind === "session" ? "sesión" : "evento";

  const rowHtml = (it) => {
    const c = it.client;
    const cvs = teamCoverages(c.id, team, kind);
    const cv = cvs[0] || null;
    const paid = Boolean(cv?.payment_id);
    const dayBusy = busy.get(it.date) || new Map();
    const opts = people.map((p) => {
      const other = dayBusy.get(p.id);
      const clash = other && other !== `${c.id}:${kind}`;
      const off = unavailableOn(p.id, it.date);
      const mine = cv?.colleague_id === p.id;
      return `<option value="${p.id}" ${mine ? "selected" : ""} ${off && !mine ? "disabled" : ""}>${esc(p.name)}${off ? " · 🚫 no disponible" : clash ? " · ⚠ ya tiene otro trabajo ese día" : ""}</option>`;
    }).join("");
    const externals = data.colleagues.filter((x) => isExternal(x) && (x.active || x.id === cv?.colleague_id)).sort((a, b) => a.name.localeCompare(b.name));
    const orphan = cv && !people.some((p) => p.id === cv.colleague_id) && !externals.some((x) => x.id === cv.colleague_id) ? `<option value="${cv.colleague_id}" selected>${esc(colleagueById(cv.colleague_id)?.name || "Colega")} (inactivo)</option>` : "";
    const extOpts = `<optgroup label="Externos">${externals.map((x) => `<option value="${x.id}" ${cv?.colleague_id === x.id ? "selected" : ""}>${esc(x.name)} (externo)</option>`).join("")}<option value="__ext">＋ Persona externa…</option></optgroup>`;
    // Sesión movida en el calendario después de asignarla.
    const outdated = kind === "session" && cv && (cv.work_date !== it.date || (it.time && hhmm(cv.arrival_time) !== it.time) || (it.location && (cv.location || "") !== it.location));
    const sub = kind === "session"
      ? [it.time ? `${it.time} h` : "sin hora", it.location, c.salon, c.code ? `#${c.code}` : "", `evento ${deps.dateText(c.eventDate)}`]
      : [c.type, c.salon, c.code ? `#${c.code}` : "", packName(c.pack)];
    const middle = kind === "session"
      ? `<div class="col-assign-time col-assign-src">${it.source === "gcal" ? `<span class="col-chip ok" title="Leída de Google Calendar">📅 Calendario</span>` : `<span class="col-chip" title="Cargada en la ficha del cliente, no la encontré en Google Calendar">Ficha</span>`}</div>`
      : `<label class="col-assign-time"><span>Inicio</span><input type="time" data-col-event-time="${c.id}" value="${esc(eventTimeOf(c.id))}" aria-label="Hora de inicio de ${esc(c.honoree || "el evento")}"></label>`;
    return `<div class="col-assign-row ${cv ? "" : "free"}">
      <div class="col-assign-date"><strong>${esc(it.date.slice(8, 10))}/${esc(it.date.slice(5, 7))}</strong><span>${esc(new Intl.DateTimeFormat("es-AR", { weekday: "short" }).format(new Date(`${it.date}T12:00:00`)))}</span></div>
      <div class="col-assign-ev"><button class="col-link" data-col="open-event" data-id="${c.id}">${kind === "session" ? "📷 Book · " : ""}${esc(c.honoree || "Evento")}</button><small>${esc(sub.filter(Boolean).join(" · "))}</small></div>
      ${middle}
      <div class="col-assign-pick">
        <select data-col-assign="${c.id}" data-col-assign-kind="${kind}" aria-label="Quién cubre ${kind === "session" ? "la sesión de" : ""} ${esc(c.honoree || "el evento")}" ${paid ? "disabled title=\"Ya está pagado: cambialo desde la ficha del evento\"" : ""}>
          <option value="">— Sin asignar —</option>${orphan}<optgroup label="${esc(teamLabel(team))}">${opts}</optgroup>${extOpts}
        </select>
        ${cv?.replacement_requested_at ? `<small class="col-due">⚠ Pidió reemplazo (ver arriba)</small>` : ""}
        ${outdated ? `<button class="col-chip warn" data-col="session-sync" data-id="${cv.id}" title="La sesión cambió en el calendario">⚠ Cambió en el calendario · actualizar</button>` : cvs.length > 1 ? `<small>+${cvs.length - 1} más del equipo (ver ficha)</small>` : paid ? `<small class="col-paid">✔ Pagado</small>` : cv && it.date < today() ? `<small class="col-due">Por pagar · ${money(cv.amount)}</small>` : ""}
      </div>
    </div>`;
  };

  let lastMonth = "";
  const list = rows.map((it) => {
    const m = it.date.slice(0, 7);
    const head = m !== lastMonth ? `<h3 class="col-assign-month">${esc(monthName(m))}</h3>` : "";
    lastMonth = m;
    return head + rowHtml(it);
  }).join("");

  const whenTabs = kind !== "event" ? "" : `<div class="view-switch col-assign-kind" aria-label="Cuándo">
    <button class="${!past ? "active" : ""}" aria-pressed="${!past}" data-col="assign-when" data-id="upcoming">Próximos</button>
    <button class="${past ? "active" : ""}" aria-pressed="${past}" data-col="assign-when" data-id="past">Anteriores (último año)</button>
  </div>`;
  const kindTabs = `<div class="col-assign-tabs">${`<div class="view-switch col-assign-kind" aria-label="Qué repartir">
    <button class="${kind === "event" ? "active" : ""}" aria-pressed="${kind === "event"}" data-col="assign-kind" data-id="event">🎉 Eventos</button>
    <button class="${kind === "session" ? "active" : ""}" aria-pressed="${kind === "session"}" data-col="assign-kind" data-id="session">📷 Sesiones de fotos</button>
  </div>`}${whenTabs}</div>`;
  const gcalNote = kind !== "session" ? "" : gcalSessions?.status === "loading" ? `<p class="col-help">Leyendo las sesiones de Google Calendar…</p>`
    : gcalSessions?.status === "not_connected" ? `<div class="col-warn">Google Calendar no está conectado: muestro solo las sesiones cargadas en las fichas. Conectalo desde <b>Calendario → Conectar Google Calendar</b>.</div>`
    : gcalSessions?.status === "error" ? `<div class="col-warn">No pude leer Google Calendar (${esc(gcalSessions.error || "error")}): muestro solo las sesiones de las fichas. <button class="ghost-btn col-mini-btn" data-col="gcal-reload">Reintentar</button></div>`
    : `<p class="col-help">Sesiones leídas de Google Calendar (próximos 7 meses) por el <b>#código</b> del título, más las cargadas en la ficha. <button class="ghost-btn col-mini-btn" data-col="gcal-reload">↻ Actualizar desde el calendario</button></p>`;
  const unmatchedHtml = kind === "session" && unmatched.length ? `<details class="col-unmatched"><summary>${unmatched.length} ${unmatched.length === 1 ? "sesión del calendario no coincide" : "sesiones del calendario no coinciden"} con ningún cliente</summary><ul>${unmatched.map((e) => `<li>${esc(deps.dateText(e.date))}${e.time ? ` ${esc(e.time)} h` : ""} · ${esc(e.title)}</li>`).join("")}</ul><p class="col-help">El título tiene que llevar el código del cliente, por ejemplo «#123 Book Sofía».</p></details>` : "";

  return `<div class="col-assign">
    ${kindTabs}
    <div class="col-assign-top">
      ${past ? `<p class="col-help">Eventos que <b>ya pasaron</b> (último año). Elegí quién lo cubrió para que quede registrado y figure en <b>«Le debés»</b>; después lo pagás con «Registrar pago». No se le mandan avisos.</p>` : kind === "event" ? `<p class="col-help">Repartiendo los eventos del <b>${esc(teamLabel(team))}</b>. Cargá la hora de <b>Inicio</b> de cada evento: el personal queda citado ${ARRIVAL_BEFORE_MIN} minutos antes. Al elegir a alguien se le asigna con su tarifa; las indicaciones las completás en la ficha del evento.</p>` : `<p class="col-help">Repartiendo las sesiones de fotos del <b>${esc(teamLabel(team))}</b>. Al elegir a alguien se le asigna con la fecha, hora y lugar de la sesión.</p>${gcalNote}`}
      <div class="toolbar col-assign-filters">
        <select data-col-assign-filter="month" aria-label="Mes"><option value="">Todos los meses</option>${months.map((m) => `<option value="${m}" ${assignMonth === m ? "selected" : ""}>${esc(monthName(m))}</option>`).join("")}</select>
        <select data-col-assign-filter="salon" aria-label="Salón"><option value="">Todos los salones</option>${salons.map((x) => `<option value="${esc(x)}" ${assignSalon === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <label class="col-toggle"><input type="checkbox" data-col-assign-filter="free" ${assignOnlyFree ? "checked" : ""}> Solo sin asignar</label>
      </div>
      <div class="col-assign-counts">
        <span class="col-chip ${free ? "warn" : "ok"}">Sin asignar: ${free}</span>
        ${people.map((p) => `<span class="col-chip">${esc(p.name.split(/\s+/)[0])}: ${counts.get(p.id) || 0}</span>`).join("")}
      </div>
      ${unmatchedHtml}
    </div>
    ${!people.length ? `<div class="panel"><div class="empty"><strong>El ${esc(teamLabel(team))} no tiene personal activo</strong>Cargalo en «👥 Personal y pagos» con «+ Agregar colega».</div></div>`
      : rows.length ? `<div class="col-assign-list">${list}</div>`
      : `<div class="panel"><div class="empty">${all.length ? "No hay nada con esos filtros." : kind === "session" ? (gcalSessions?.status === "loading" ? "Buscando sesiones…" : "No hay sesiones de fotos próximas.") : "No hay eventos próximos cargados."}</div></div>`}
  </div>`;
}

function assignFromSelector(select) {
  const clientId = select.dataset.colAssign;
  const kind = select.dataset.colAssignKind === "session" ? "session" : "event";
  if (select.value === "__ext") { refreshAll(); openExternalForm(clientId, kind); return; }
  select.disabled = true;
  return applyAssignment(clientId, select.value, kind);
}

// Persona ajena: se carga una vez (queda en "Externos") y se le asigna el evento.
function openExternalForm(clientId, kind = "event", replaceId = "") {
  const client = clientById(clientId); if (!client) return;
  showDialog("colFormDialog", `<form id="colExternalForm" data-client="${clientId}" data-kind="${kind}" data-replace="${replaceId}">
    ${head(`${deps.dateText(client.eventDate)} · ${client.salon || ""}`, `Persona externa para ${client.honoree || "el evento"}`, "colFormDialog")}
    <p class="col-help">Queda registrado quién cubrió (en el grupo «Externos», aparte de tu equipo) y te abre el WhatsApp con día, hora y lugar para pasarle la info.</p>
    <div class="form-grid">
      <label>Nombre y apellido<input name="name" required maxlength="80" placeholder="Ej. Juan Pérez"></label>
      <label>WhatsApp<input name="phone" type="tel" inputmode="tel" placeholder="Ej. 11 2345 6789"></label>
      <label>Función<input name="role" maxlength="60" placeholder="Fotógrafo, videógrafo…" list="colRoleList3"></label>
      <label>Monto a pagarle <small>(0 si no le pagás vos)</small><input name="amount" type="number" min="0" step="1" inputmode="numeric" placeholder="0"></label>
    </div>
    <datalist id="colRoleList3"><option>Fotógrafo</option><option>Videógrafo</option><option>Asistente</option><option>Drone</option></datalist>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">Asignar</button>
    </div>
  </form>`);
}
async function saveExternalForm(form) {
  const f = new FormData(form);
  const name = String(f.get("name") || "").trim();
  if (!name) { toast("Poné el nombre de la persona."); return; }
  await withBusy(form, async () => {
    const [person] = await run(supabase.from("colleagues").insert({
      name, phone: String(f.get("phone") || "").trim() || null, role: String(f.get("role") || "").trim() || null,
      default_fee: num(f.get("amount")), team: EXTERNAL_TEAM,
    }).select());
    data.colleagues = [...data.colleagues, person].sort((a, b) => a.name.localeCompare(b.name));
    closeDialog("colFormDialog");
    if (form.dataset.replace) await replaceCoverage(form.dataset.replace, person.id);
    else await applyAssignment(form.dataset.client, person.id, form.dataset.kind === "session" ? "session" : "event");
  });
}

// La sesión se movió en Google Calendar: actualiza fecha/hora/lugar y avisa.
async function syncSessionCoverage(id) {
  const cv = data.coverages.find((x) => x.id === id); if (!cv) return;
  const info = sessionInfo.get(cv.client_id); if (!info) return;
  const [saved] = await run(supabase.from("colleague_coverages").update({ work_date: info.date, arrival_time: info.time || cv.arrival_time || null, location: info.location || cv.location || null }).eq("id", id).select());
  data.coverages = data.coverages.map((x) => (x.id === id ? saved : x));
  toast("Sesión actualizada con los datos del calendario");
  await notifyChange({ client: clientById(cv.client_id), cv: saved, changed: colleagueById(cv.colleague_id) });
  refreshAll();
}

async function applyAssignment(clientId, newId, kind = "event") {
  const client = clientById(clientId);
  const team = assignTeam();
  const current = teamCoverages(clientId, team, kind)[0] || null;
  const info = kind === "session" ? sessionInfo.get(clientId) || (photoSessionOf(client) ? { date: photoSessionOf(client).date, time: photoSessionOf(client).time || "", location: photoSessionOf(client).location || "" } : null) : null;
  const prevId = current?.colleague_id || "";
  if (prevId === newId) { refreshAll(); return; }
  try {
    if (current?.payment_id) throw new Error("Esa cobertura ya está pagada: cambiala desde la ficha del evento.");
    if (kind === "session" && !info?.date) throw new Error("No encontré la fecha de la sesión de fotos.");
    if (newId && data.coverages.some((cv) => cv.client_id === clientId && cv.colleague_id === newId && (cv.kind || "event") === kind && cv.id !== current?.id)) throw new Error(kind === "session" ? "Ya está asignada a esta sesión." : "Ya está asignada a este evento.");
    const person = newId ? colleagueById(newId) : null;
    if (current?.drive_shared_at) await driveRequest("unshare", { coverageId: current.id }).catch(() => {});
    let saved = null;
    if (!newId) {
      await run(supabase.from("colleague_coverages").delete().eq("id", current.id));
      data.coverages = data.coverages.filter((x) => x.id !== current.id);
      toast(`${kind === "session" ? "Sesión de " : ""}${client?.honoree || "Evento"}: sin asignar`);
    } else if (current) {
      [saved] = await run(supabase.from("colleague_coverages").update({ colleague_id: newId, team, arrival_time: current.arrival_time || (kind === "session" ? info?.time : suggestedArrival(clientId)) || null, amount: num(person?.default_fee), role: person?.role || current.role || null, drive_shared_at: null, drive_shared_email: null }).eq("id", current.id).select());
      data.coverages = data.coverages.map((x) => (x.id === current.id ? saved : x));
    } else {
      [saved] = await run(supabase.from("colleague_coverages").insert(kind === "session" ? {
        client_id: clientId, colleague_id: newId, kind, team, role: person?.role || null,
        work_date: info.date, arrival_time: info.time || null, location: info.location || null, amount: num(person?.default_fee),
      } : {
        client_id: clientId, colleague_id: newId, kind: "event", team, role: person?.role || null, arrival_time: suggestedArrival(clientId) || null,
        amount: num(person?.default_fee), location: lastLocationForSalon(client?.salon) || client?.salon || null,
      }).select());
      data.coverages = [...data.coverages, saved];
    }
    await notifyChange({ client, cv: saved || current, added: saved ? person : null, removed: prevId && prevId !== newId ? colleagueById(prevId) : null });
    if (saved) {
      toast(`${kind === "session" ? "Sesión de " : ""}${client?.honoree || "Evento"} → ${person?.name}`);
      // Si el evento ya tiene carpeta de Drive conectada, se la comparte sola.
      if (client?.driveUrl && person?.email && deps.driveAutoAvailable(client.salon)) await shareDrive(saved.id).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), 6000);
  }
  refreshAll();
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
      <div class="col-cover-btns">
        ${photoSessionOf(client) ? `<button class="secondary-btn" data-col="assign-session" data-id="${client.id}">+ Sesión de fotos</button>` : ""}
        <button class="secondary-btn" data-col="assign" data-id="${client.id}">+ Asignar colega</button>
      </div>
    </div>
    ${noFolder ? `<div class="col-warn">⚠ Este evento todavía no tiene carpeta de Drive. Creala con <b>«Crear carpeta en Drive»</b> (abajo) para que los colegas puedan subir las fotos.</div>` : ""}
    ${covers.map((cv) => coverRowHtml(cv, client)).join("")}
    ${colleagueActivityHtml(client)}
  </div>`;
}

// Lo que hicieron las colegas desde su portal: tareas marcadas (a confirmar)
// y notas. Se guarda aparte para que el guardado de la app no lo pise.
function colleagueActivityHtml(client) {
  const marks = data.marks
    .filter((m) => m.client_id === client.id)
    .map((m) => ({ m, task: (client.tasks || []).find((t) => t.id === m.task_id) }))
    .filter((x) => x.task && x.task.status !== "done");
  const notes = data.notes.filter((n) => n.client_id === client.id);
  if (!marks.length && !notes.length) return "";
  const when = (iso) => new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return `<div class="col-activity">
    ${marks.map(({ m, task }) => `<div class="col-activity-row"><span>✔ <b>${esc(m.author_name)}</b> marcó <b>«${esc(task.title)}»</b> como hecha <small>${esc(when(m.done_at))}</small></span>
      <span class="col-activity-btns"><button class="primary-btn col-mini-btn" data-col="mark-confirm" data-id="${m.task_id}">Confirmar</button><button class="ghost-btn col-mini-btn" data-col="mark-discard" data-id="${m.task_id}">Descartar</button></span></div>`).join("")}
    ${notes.map((n) => `<div class="col-activity-row col-activity-note"><span>📝 <b>${esc(n.author_name)}</b> <small>${esc(when(n.created_at))}</small><br>${esc(n.body)}</span>
      <span class="col-activity-btns"><button class="ghost-btn col-mini-btn" data-col="note-delete" data-id="${n.id}">Borrar</button></span></div>`).join("")}
  </div>`;
}

async function confirmMark(taskId) {
  const m = data.marks.find((x) => x.task_id === taskId); if (!m) return;
  // Mismo camino que marcar la tarea a mano (genera la rendición si corresponde).
  deps.updateTask(m.client_id, taskId, "done");
  const task = clientById(m.client_id)?.tasks?.find((t) => t.id === taskId);
  if (task?.status !== "done") return; // updateTask avisó qué falta (ej. nº de pedido)
  await run(supabase.from("colleague_task_marks").delete().eq("task_id", taskId));
  data.marks = data.marks.filter((x) => x.task_id !== taskId);
  toast("Tarea confirmada como hecha");
  refreshAll(m.client_id);
}
async function discardMark(taskId) {
  const m = data.marks.find((x) => x.task_id === taskId); if (!m) return;
  if (!confirm(`¿Descartar la marca de ${m.author_name}? La tarea sigue pendiente.`)) return;
  await run(supabase.from("colleague_task_marks").delete().eq("task_id", taskId));
  data.marks = data.marks.filter((x) => x.task_id !== taskId);
  toast("Marca descartada");
  refreshAll(m.client_id);
}
async function deleteNote(id) {
  const n = data.notes.find((x) => x.id === id); if (!n) return;
  if (!confirm(`¿Borrar la nota de ${n.author_name}?`)) return;
  await run(supabase.from("colleague_notes").delete().eq("id", id));
  data.notes = data.notes.filter((x) => x.id !== id);
  toast("Nota borrada");
  refreshAll(n.client_id);
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
    <div class="col-cover-main"><strong>${esc(c?.name || "Colega")}${isExternal(c) ? ` <span class="col-chip">Externo</span>` : ""}${cv.replacement_requested_at ? ` <span class="col-chip warn">⚠ Pidió reemplazo</span>` : ""}${isSession(cv) ? ` <span class="col-chip">📷 Sesión ${esc(deps.dateText(coverageDate(cv)))}</span>` : ""}</strong><span>${esc(cv.role || c?.role || "")}${cv.role || c?.role ? " · " : ""}${esc(time)}${cv.location ? ` · ${esc(cv.location)}` : ""}</span>${cv.notes ? `<small>${esc(cv.notes)}</small>` : ""}</div>
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
    // Cierra solo si el click empieza Y termina en el fondo: al seleccionar
    // texto arrastrando y soltar fuera del recuadro no se tiene que cerrar.
    let downOnBackdrop = false;
    d.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === d; });
    d.addEventListener("click", (e) => { if (e.target === d && downOnBackdrop) d.close(); downOnBackdrop = false; });
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

// Tipos de tarea que existen en los clientes (task_key → título y etapa).
const PHASE_ORDER = ["Preparación", "Pre-evento", "Evento", "Servicios elegidos", "Servicios VIP", "Adicionales", "Post-evento", "Entrega"];
function taskTypes() {
  const map = new Map();
  deps.getClients().forEach((c) => (c.tasks || []).forEach((t) => { if (t.key && !map.has(t.key)) map.set(t.key, { key: t.key, title: t.title, phase: t.phase || "Otras" }); }));
  return [...map.values()].sort((a, b) => ((PHASE_ORDER.indexOf(a.phase) + 1 || 99) - (PHASE_ORDER.indexOf(b.phase) + 1 || 99)) || a.title.localeCompare(b.title));
}
function taskKeysFieldset(selected = []) {
  const types = taskTypes();
  const sel = new Set(selected || []);
  const phases = [...new Set(types.map((t) => t.phase))];
  return `<details class="col-taskkeys" ${sel.size ? "" : "open"}>
    <summary>Tareas que ve y puede tildar en su portal <b data-col-taskkeys-count>${sel.size}</b></summary>
    <p class="col-help">Solo le aparecen las que marques. Si no marcás ninguna, no ve tareas.</p>
    ${phases.map((ph) => `<fieldset><legend>${esc(ph)}</legend>${types.filter((t) => t.phase === ph).map((t) => `<label class="col-check"><input type="checkbox" name="task_keys" value="${esc(t.key)}" ${sel.has(t.key) ? "checked" : ""}> ${esc(t.title)}</label>`).join("")}</fieldset>`).join("") || `<span class="col-sub">Todavía no hay tareas cargadas en tus clientes.</span>`}
  </details>`;
}

function salonOptions(selected = []) {
  const set = new Set([...(selected || []), ...deps.getClients().map((c) => c.salon).filter(Boolean)]);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Alta / edición de colega
function openColleagueForm(colleague) {
  const c = colleague || { name: "", role: "", phone: "", email: "", default_fee: 0, notes: "", active: true, team: currentPanel() };
  showDialog("colFormDialog", `<form id="colColleagueForm" data-id="${c.id || ""}">
    ${head("Equipo", c.id ? `Editar ${c.name}` : "Nuevo colega", "colFormDialog")}
    <div class="form-grid">
      <label>Nombre y apellido<input name="name" required maxlength="80" value="${esc(c.name)}" placeholder="Ej. Dylan Pérez"></label>
      <label>Función<input name="role" maxlength="60" value="${esc(c.role || "")}" placeholder="Fotógrafo, videógrafo, asistente…" list="colRoleList"></label>
      <label>Equipo (quién lo maneja y le paga)<select name="team">${allTeams().map((t) => `<option value="${esc(t)}" ${teamOf(c) === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      <label>WhatsApp<input name="phone" type="tel" inputmode="tel" value="${esc(c.phone || "")}" placeholder="Ej. 11 2345 6789"></label>
      <label>Gmail (para compartirle Drive)<input name="email" type="email" inputmode="email" value="${esc(c.email || "")}" placeholder="nombre@gmail.com"></label>
      <label>Tarifa por evento<input name="default_fee" type="number" min="0" step="1" inputmode="numeric" value="${Number(c.default_fee) || ""}" placeholder="Ej. 60000"></label>
      ${c.id ? `<label class="col-check"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Activo (si lo desactivás, deja de funcionar su calendario)</label>` : ""}
    </div>
    <fieldset class="col-salons"><legend>Salones asignados <small>(ve todos los eventos y tareas de estos salones en su portal)</small></legend>
      ${salonOptions(c.salons).map((s) => `<label class="col-check"><input type="checkbox" name="salons" value="${esc(s)}" ${(c.salons || []).includes(s) ? "checked" : ""}> ${esc(s)}</label>`).join("") || `<span class="col-sub">Todavía no hay salones cargados en tus clientes.</span>`}
    </fieldset>
    ${isExternal(c) ? "" : taskKeysFieldset(c.task_keys)}
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
    salons: f.getAll("salons").map(String),
    team: String(f.get("team") || "Pablo"),
  };
  if (form.querySelector("input[name=task_keys]")) row.task_keys = f.getAll("task_keys").map(String);
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

function openCoverageForm(clientId, coverage, kind = "event") {
  const client = clientById(clientId); if (!client) return;
  const ps = photoSessionOf(client);
  const cv = coverage || (kind === "session"
    ? { kind, work_date: ps?.date || "", colleague_id: "", role: "", arrival_time: ps?.time || "", end_time: "", location: ps?.location || "", amount: "", notes: ps?.notes || "" }
    : { kind, work_date: "", colleague_id: "", role: "", arrival_time: "", end_time: "", location: lastLocationForSalon(client.salon) || client.salon || "", amount: "", notes: "" });
  const session = isSession(cv);
  const paid = Boolean(coverage?.payment_id);
  const taken = new Set(data.coverages.filter((x) => x.client_id === clientId && x.id !== coverage?.id && (x.kind || "event") === (cv.kind || "event")).map((x) => x.colleague_id));
  const options = data.colleagues.filter((c) => (c.active || c.id === cv.colleague_id) && !taken.has(c.id));
  showDialog("colFormDialog", `<form id="colCoverageForm" data-client="${clientId}" data-id="${coverage?.id || ""}">
    ${head(`#${client.code} · ${client.salon} · Evento ${deps.dateText(client.eventDate)}`, `${coverage ? "Editar" : "Asignar"} ${session ? "sesión de fotos" : "cobertura del evento"} · ${client.honoree}`, "colFormDialog")}
    <input type="hidden" name="kind" value="${session ? "session" : "event"}">
    ${paid ? `<div class="col-warn">Esta cobertura ya está incluida en un pago: el colega y el monto no se pueden cambiar (deshacé el pago si hace falta).</div>` : ""}
    <div class="form-grid">
      <label>Colega<select name="colleague_id" required ${paid ? "disabled" : ""}>
        <option value="">Elegí de la lista…</option>
        ${allTeams().filter((t) => options.some((c) => teamOf(c) === t)).map((t) => `<optgroup label="${esc(teamLabel(t))}">${options.filter((c) => teamOf(c) === t).map((c) => `<option value="${c.id}" data-fee="${Number(c.default_fee) || 0}" data-role="${esc(c.role || "")}" ${c.id === cv.colleague_id ? "selected" : ""}>${esc(c.name)}${c.role ? ` · ${esc(c.role)}` : ""}</option>`).join("")}</optgroup>`).join("")}
        ${coverage ? "" : `<option value="__new">＋ Agregar un colega nuevo…</option><option value="__ext">＋ Persona externa (ajena a los equipos)…</option>`}
      </select></label>
      <label>Función en este evento<input name="role" maxlength="60" value="${esc(cv.role || "")}" placeholder="Fotógrafo, videógrafo…" list="colRoleList2"></label>
      <div class="col-new-fields hidden">
        <label><span data-col-new-label>Nombre del colega nuevo</span><input name="new_name" maxlength="80" placeholder="Nombre y apellido"></label>
        <label>WhatsApp<input name="new_phone" type="tel" inputmode="tel" placeholder="Ej. 11 2345 6789"></label>
        <label>Gmail (para Drive)<input name="new_email" type="email" placeholder="nombre@gmail.com"></label>
      </div>
      ${session ? `<label>Fecha de la sesión<input name="work_date" type="date" required value="${esc(cv.work_date || "")}"></label>` : ""}
      ${session ? "" : `<label>Inicio del evento<input name="event_time" type="time" value="${esc(eventTimeOf(clientId))}"></label>`}
      <label>Hora de llegada <small>${session ? "" : `(${ARRIVAL_BEFORE_MIN} min antes)`}</small><input name="arrival_time" type="time" value="${hhmm(cv.arrival_time) || (session ? "" : suggestedArrival(clientId))}" data-auto="${cv.arrival_time ? "0" : "1"}"></label>
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
  const isNew = select.value === "__new" || select.value === "__ext";
  form.querySelector(".col-new-fields").classList.toggle("hidden", !isNew);
  const lbl = form.querySelector("[data-col-new-label]");
  if (lbl) lbl.textContent = select.value === "__ext" ? "Nombre de la persona externa" : "Nombre del colega nuevo";
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
  const kind = existing?.kind || (f.get("kind") === "session" ? "session" : "event");
  const workDate = kind === "session" ? String(f.get("work_date") || "") : "";
  if (kind === "session" && !workDate) { toast("Poné la fecha de la sesión de fotos."); return; }
  const eventTime = f.has("event_time") ? String(f.get("event_time") || "") : null;
  await withBusy(form, async () => {
    if (eventTime !== null && eventTime !== eventTimeOf(clientId)) await setEventTime(clientId, eventTime);
    if (colleagueId === "__new" || colleagueId === "__ext") {
      const external = colleagueId === "__ext";
      const name = String(f.get("new_name") || "").trim();
      const email = String(f.get("new_email") || "").trim().toLowerCase();
      if (!name) throw new Error("Poné el nombre del colega nuevo.");
      if (email && !validEmail(email)) throw new Error("Revisá el Gmail del colega nuevo.");
      const [saved] = await run(supabase.from("colleagues").insert({
        name, phone: String(f.get("new_phone") || "").trim() || null, email: email || null,
        role: String(f.get("role") || "").trim() || null, default_fee: num(f.get("amount")),
        team: external ? EXTERNAL_TEAM : assignTeam(),
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
      work_date: workDate || null,
    };
    if (!existing?.payment_id) { row.colleague_id = colleagueId; row.amount = num(f.get("amount")); }
    // Externos: la cobertura recuerda qué equipo la asignó (para el reparto).
    if (isExternal(colleagueById(colleagueId)) && !existing?.team) row.team = assignTeam();
    if (data.coverages.some((x) => x.client_id === clientId && x.id !== id && x.colleague_id === (row.colleague_id || existing?.colleague_id) && (x.kind || "event") === kind)) throw new Error(`Ese colega ya está asignado a ${kind === "session" ? "la sesión de fotos" : "este evento"}.`);
    let saved;
    if (existing) {
      [saved] = await run(supabase.from("colleague_coverages").update(row).eq("id", id).select());
      data.coverages = data.coverages.map((x) => (x.id === id ? saved : x));
    } else {
      [saved] = await run(supabase.from("colleague_coverages").insert({ ...row, kind, client_id: clientId }).select());
      data.coverages = [...data.coverages, saved];
    }
    closeDialog("colFormDialog");
    refreshAll(clientId);
    const swapped = existing && existing.colleague_id !== saved.colleague_id;
    const moved = existing && !swapped && (hhmm(existing.arrival_time) !== hhmm(saved.arrival_time) || (existing.location || "") !== (saved.location || "") || (existing.work_date || "") !== (saved.work_date || ""));
    await notifyChange({
      client, cv: saved,
      added: !existing || swapped ? colleagueById(saved.colleague_id) : null,
      removed: swapped ? colleagueById(existing.colleague_id) : null,
      changed: moved ? colleagueById(saved.colleague_id) : null,
    });
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
  await notifyChange({ client: clientById(cv.client_id), cv, removed: c });
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

// ── avisos al personal (portal + WhatsApp a último momento) ───────────────
// Cada cambio deja un aviso en el portal de la colega (/colega.html). Si el
// trabajo es dentro de los próximos 7 días, además ofrece mandar WhatsApp.
const LAST_MINUTE_DAYS = 7;
let pendingWa = {};
function daysUntil(iso) { return Math.round((new Date(`${iso}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 86400000); }
async function notifyChange({ client, cv, added = null, removed = null, changed = null, offerWa = true }) {
  if (!client || !cv || (!added && !removed && !changed)) return;
  // Trabajos que ya pasaron (cargados para pagarlos): sin avisos al personal.
  if (coverageDate(cv) < today()) return;
  const what = isSession(cv) ? "la sesión de fotos de" : "el evento de";
  const label = `${client.honoree || "Evento"}${client.type ? ` (${client.type})` : ""} · ${client.salon || ""} · ${dateLong(coverageDate(cv))}`;
  const time = cv.arrival_time ? ` Presentarte ${hhmm(cv.arrival_time)} h.` : "";
  const place = cv.location ? ` Lugar: ${cv.location}.` : "";
  const rows = [];
  if (added) rows.push({ colleague_id: added.id, client_id: client.id, kind: "assigned", message: `Te asignaron ${what} ${label}.${time}${place}` });
  if (removed) rows.push({ colleague_id: removed.id, client_id: client.id, kind: "removed", message: `Ya no cubrís ${what} ${label}. Hubo un cambio de personal.` });
  if (changed) rows.push({ colleague_id: changed.id, client_id: client.id, kind: "changed", message: `Cambiaron los datos ${isSession(cv) ? "de la sesión de fotos de" : "del evento de"} ${label}.${time}${place}` });
  const { error } = await supabase.from("colleague_notices").insert(rows);
  if (error) console.warn("No se pudo guardar el aviso:", error.message);

  const d = daysUntil(coverageDate(cv));
  const lastMinute = d >= 0 && d <= LAST_MINUTE_DAYS;
  // A una persona externa siempre hay que pasarle la info (no tiene portal).
  const externalNew = added && isExternal(added) && d >= 0;
  if (!offerWa || (!lastMinute && !externalNew)) return;
  pendingWa = {};
  const people = [];
  if (added?.phone) { pendingWa[added.id] = coverageMessage(cv); people.push({ c: added, label: `💬 Avisar a ${firstName(added.name)} (entra)` }); }
  if (changed?.phone) { pendingWa[changed.id] = `Hola ${firstName(changed.name)}! Hubo un cambio:\n\n${coverageMessage(cv).split("\n").slice(2).join("\n")}`; people.push({ c: changed, label: `💬 Avisar a ${firstName(changed.name)} del cambio` }); }
  if (removed?.phone) { pendingWa[removed.id] = `Hola ${firstName(removed.name)}! Te aviso que hubo un cambio de personal: ya no cubrís ${what} ${label}. ¡Gracias igual! 🙌`; people.push({ c: removed, label: `💬 Avisar a ${firstName(removed.name)} (sale)` }); }
  if (!people.length) return;
  showDialog("colFormDialog", `<div class="col-cal">
    ${head(d === 0 ? "Es hoy" : `Faltan ${d} ${d === 1 ? "día" : "días"}`, externalNew && !lastMinute ? "Mandale la info por WhatsApp" : "¿Les avisás por WhatsApp?", "colFormDialog")}
    <p class="col-help">${externalNew && !lastMinute ? "Pasale la info del evento a la persona externa por WhatsApp (se abre con el mensaje escrito)." : "Ya les quedó el aviso en su portal. Como es a último momento, mandales también un WhatsApp (se abre con el mensaje escrito)."}</p>
    <div class="modal-actions col-cal-actions">
      <button class="ghost-btn" type="button" data-col="close" data-id="colFormDialog">No, gracias</button>
      ${people.map((p) => `<button class="primary-btn" type="button" data-col="notify-wa" data-id="${p.c.id}">${esc(p.label)}</button>`).join("")}
    </div>
  </div>`);
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
    `Hola ${firstName(c?.name)}! Te paso los datos ${isSession(cv) ? "de la sesión de fotos" : "del evento"}:`,
    "",
    `📅 ${dateLong(coverageDate(cv))}`,
    (() => {
      const arrival = hhmm(cv.arrival_time) || (isSession(cv) ? "" : suggestedArrival(cv.client_id));
      const start = isSession(cv) ? "" : eventTimeOf(cv.client_id);
      if (!arrival) return start ? `🕒 El evento empieza a las ${start} h` : null;
      return `🕒 Presentarte a las ${arrival} h${start ? ` (el evento empieza a las ${start} h)` : ""}${cv.end_time ? ` · hasta las ${hhmm(cv.end_time)} h` : ""}`;
    })(),
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
  if (p.kind === "advance") {
    const s = c ? summary(c) : null;
    return [`Hola ${firstName(c?.name)}! Te pagué ${money(p.net)} a cuenta (${deps.dateText(p.paid_on)}).`, p.notes || null, s ? `Te queda por cobrar: ${money(s.net)}` : null].filter(Boolean).join("\n");
  }
  const lines = [`Hola ${firstName(c?.name)}! Te pagué ${money(p.net)} (${deps.dateText(p.paid_on)}). Detalle:`, ""];
  covers.forEach((cv) => { const cl = clientById(cv.client_id); lines.push(`• ${cl ? `${deps.dateText(coverageDate(cv))} ${isSession(cv) ? "Sesión " : ""}${cl.honoree}` : "Evento"}: ${money(cv.amount)}`); });
  apps.forEach((a) => {
    const d = data.discounts.find((x) => x.id === a.discount_id);
    lines.push(`• Descuento ${d ? `${d.description}${d.installments > 1 ? ` (cuota ${installmentNumber(d, p.id)}/${d.installments})` : ""}` : ""}: −${money(a.amount)}`);
  });
  if (Number(p.advance_used) > 0) lines.push(`• Ya cobrado a cuenta: −${money(p.advance_used)}`);
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
    return `<tr><td>${cl ? esc(deps.dateText(coverageDate(cv))) : "—"}</td><td><button class="col-link" data-col="open-event" data-id="${cv.client_id}">${cl ? `${isSession(cv) ? "📷 Sesión · " : ""}${esc(cl.honoree)} <small>#${esc(cl.code)} · ${esc(cl.salon)}</small>` : "Evento borrado"}</button></td><td>${esc(cv.role || "")}</td><td>${cv.arrival_time ? `${hhmm(cv.arrival_time)} h` : ""}</td><td class="num">${money(cv.amount)}</td><td>${st}</td></tr>`;
  };
  showDialog("colDetailDialog", `<div class="col-detail">
    ${head(`${c.role || "Colega"}${c.active ? "" : " · Inactivo"}`, c.name, "colDetailDialog")}
    <div class="col-detail-top">
      <div class="col-owed ${s.net > 0 ? "has-debt" : ""}"><span>Le debés hoy</span><strong>${money(s.net)}</strong><small>${owedDetail(s)}</small></div>
      <div class="col-detail-actions">
        <button class="secondary-btn" data-col="advance" data-id="${id}">💵 Pago a cuenta</button>
        <button class="primary-btn" data-col="pay" data-id="${id}">Registrar pago</button>
        <button class="secondary-btn" data-col="add-discount" data-id="${id}">+ Descuento</button>
        <button class="secondary-btn" data-col="calendar" data-id="${id}" ${c.active ? "" : "disabled"}>📅 Calendario</button>
        <button class="ghost-btn" data-col="edit-colleague" data-id="${id}">✎ Editar</button>
      </div>
    </div>
    <h3 class="col-section">Coberturas <small>${covers.length}</small></h3>
    ${covers.length ? `<div class="col-table-wrap"><table class="col-table"><thead><tr><th>Fecha</th><th>Evento</th><th>Función</th><th>Llega</th><th class="num">Monto</th><th></th></tr></thead><tbody>${covers.map(coverRow).join("")}</tbody></table></div>` : `<p class="col-empty">Todavía no tiene eventos asignados. Se asignan desde la ficha de cada evento.</p>`}
    <h3 class="col-section">Descuentos <small>${discounts.length}</small></h3>
    ${discounts.length ? `<div class="col-table-wrap"><table class="col-table"><thead><tr><th>Concepto</th><th class="num">Total</th><th>Cuotas</th><th class="num">Descontado</th><th class="num">Resta</th><th></th></tr></thead><tbody>${discounts.map((d) => { const rem = discountRemaining(d); const applied = data.applications.filter((a) => a.discount_id === d.id).length; return `<tr><td>${esc(d.description)}<small class="col-sub">${esc(deps.dateText(d.created_on))}</small></td><td class="num">${money(d.total_amount)}</td><td>${applied}/${d.installments}${rem > 0 && d.installments > 1 ? `<small class="col-sub">cuota ${money(suggestedInstallment(d))}</small>` : ""}</td><td class="num">${money(discountApplied(d))}</td><td class="num">${rem > 0 ? money(rem) : `<span class="col-chip ok">Saldado</span>`}</td><td class="col-row-actions">${rem > 0 ? `<button class="icon-btn col-mini" title="Editar cuotas, total o concepto" aria-label="Editar descuento" data-col="edit-discount" data-id="${d.id}">✎</button>` : ""}${applied ? "" : `<button class="icon-btn col-mini" title="Borrar descuento" data-col="del-discount" data-id="${d.id}">×</button>`}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="col-empty">Sin descuentos. Usalos si, por ejemplo, le vendiste equipo y se lo descontás de sus trabajos.</p>`}
    <h3 class="col-section">Pagos <small>${payments.length}</small></h3>
    ${payments.length ? `<div class="col-table-wrap"><table class="col-table"><thead><tr><th>Fecha</th><th>Eventos</th><th class="num">Bruto</th><th class="num">Descuentos</th><th class="num">Pagado</th><th></th></tr></thead><tbody>${payments.map((p) => `<tr><td>${esc(deps.dateText(p.paid_on))}${p.notes ? `<small class="col-sub">${esc(p.notes)}</small>` : ""}</td><td>${p.kind === "advance" ? `<span class="col-chip">💵 A cuenta</span>` : data.coverages.filter((cv) => cv.payment_id === p.id).length}</td><td class="num">${p.kind === "advance" ? "—" : money(p.gross)}</td><td class="num">${[Number(p.discounts) ? `−${money(p.discounts)}` : "", Number(p.advance_used) ? `−${money(p.advance_used)} a cuenta` : ""].filter(Boolean).join("<br>") || "—"}</td><td class="num"><strong>${money(p.net)}</strong></td><td class="col-row-actions"><button class="icon-btn col-mini" title="Mandar el detalle por WhatsApp" data-col="wa-payment" data-id="${p.id}">💬</button><button class="ghost-btn col-undo" data-col="undo-payment" data-id="${p.id}">Deshacer</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="col-empty">Todavía no le registraste pagos.</p>`}
    ${c.notes ? `<p class="col-notes">📝 ${esc(c.notes)}</p>` : ""}
  </div>`);
}

// ── descuentos ────────────────────────────────────────────────────────────
function openDiscountForm(colleagueId, discount = null) {
  const c = colleagueById(colleagueId); if (!c) return;
  const d = discount || { description: "", total_amount: "", installments: 1, created_on: today() };
  const applied = discount ? discountApplied(discount) : 0;
  const paidCuotas = discount ? data.applications.filter((a) => a.discount_id === discount.id).length : 0;
  showDialog("colFormDialog", `<form id="colDiscountForm" data-colleague="${colleagueId}" data-id="${discount?.id || ""}">
    ${head(c.name, discount ? "Editar descuento" : "Nuevo descuento", "colFormDialog")}
    ${discount && applied > 0 ? `<div class="col-warn">Ya se descontaron ${money(applied)} en ${paidCuotas} ${paidCuotas === 1 ? "pago" : "pagos"}. El total no puede ser menor a eso; las cuotas que cambies se aplican a lo que resta.</div>` : ""}
    <div class="form-grid">
      <label>Concepto<input name="description" required maxlength="120" value="${esc(d.description)}" placeholder="Ej. Lente 50mm que le vendí"></label>
      <label>Monto total<input name="total_amount" required type="number" min="${Math.max(1, applied)}" step="1" inputmode="numeric" value="${d.total_amount === "" ? "" : Number(d.total_amount)}" placeholder="Ej. 300000"></label>
      <label>¿En cuántas cuotas?<input name="installments" required type="number" min="1" max="60" step="1" value="${Number(d.installments) || 1}"></label>
      <label>Fecha<input name="created_on" type="date" value="${esc(d.created_on || today())}"></label>
    </div>
    <p class="col-help" data-col-discount-help>Se descuenta todo en el próximo pago.</p>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">Guardar descuento</button>
    </div>
  </form>`);
  updateDiscountHelp(document.getElementById("colDiscountForm"));
}
function updateDiscountHelp(form) {
  const total = num(form.elements.total_amount.value), n = Math.max(1, Number(form.elements.installments.value) || 1);
  form.querySelector("[data-col-discount-help]").textContent = !total ? "" : n === 1 ? "Se descuenta todo en el próximo pago." : `Cuota de ${money(num(total / n))} en cada pago (al pagar la podés cambiar o poner en 0 ese mes).`;
}
async function saveDiscountForm(form) {
  const f = new FormData(form);
  const row = { colleague_id: form.dataset.colleague, description: String(f.get("description") || "").trim(), total_amount: num(f.get("total_amount")), installments: Math.min(60, Math.max(1, Number(f.get("installments")) || 1)), created_on: f.get("created_on") || today() };
  if (!row.description || row.total_amount <= 0) { toast("Completá el concepto y el monto."); return; }
  const id = form.dataset.id;
  const existing = id ? data.discounts.find((d) => d.id === id) : null;
  if (existing && row.total_amount < discountApplied(existing)) { toast(`El total no puede ser menor a lo ya descontado (${money(discountApplied(existing))}).`); return; }
  await withBusy(form, async () => {
    if (existing) {
      const { colleague_id, ...changes } = row;
      const [saved] = await run(supabase.from("colleague_discounts").update(changes).eq("id", id).select());
      data.discounts = data.discounts.map((d) => (d.id === id ? saved : d));
    } else {
      const [saved] = await run(supabase.from("colleague_discounts").insert(row).select());
      data.discounts = [...data.discounts, saved];
    }
    closeDialog("colFormDialog"); toast(existing ? "Descuento actualizado" : "Descuento guardado"); refreshAll();
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
  if (!unpaid.length && !discounts.length) { openAdvanceForm(colleagueId); return; }
  const credit = advanceCredit(colleagueId);
  showDialog("colFormDialog", `<form id="colPaymentForm" data-colleague="${colleagueId}">
    ${head(c.name, "Registrar pago", "colFormDialog")}
    <div class="col-pay-switch"><span>¿Le das solo una parte o un adelanto?</span><button class="secondary-btn col-mini-btn" type="button" data-col="advance" data-id="${colleagueId}">💵 Registrar pago a cuenta</button></div>
    ${unpaid.length ? `<p class="col-label">Eventos que le pagás <small>(los futuros vienen sin marcar)</small></p>
    <div class="col-pay-list">${unpaid.map((cv) => { const cl = clientById(cv.client_id); return `<label class="col-pay-item"><input type="checkbox" name="coverage" value="${cv.id}" data-amount="${Number(cv.amount)}" ${isDue(cv) ? "checked" : ""}><span>${cl ? `${esc(deps.dateText(coverageDate(cv)))} · ${isSession(cv) ? "Sesión · " : ""}${esc(cl.honoree)}` : "Evento"}${isDue(cv) ? "" : ` <em>· próximo</em>`}</span><strong>${money(cv.amount)}</strong></label>`; }).join("")}</div>` : ""}
    ${discounts.length ? `<p class="col-label">Descuentos de este pago</p>
    <div class="col-pay-list">${discounts.map((d) => `<label class="col-pay-item col-pay-disc"><span>${esc(d.description)} <em>· resta ${money(discountRemaining(d))}${d.installments > 1 ? ` · cuota sugerida ${money(suggestedInstallment(d))}` : ""}</em></span><input type="number" name="discount" data-id="${d.id}" min="0" max="${discountRemaining(d)}" step="1" value="${suggestedInstallment(d)}"></label>`).join("")}</div>` : ""}
    ${credit > 0 ? `<p class="col-label">Pagos a cuenta que ya le diste</p>
    <div class="col-pay-list"><label class="col-pay-item col-pay-disc"><span>Descontar de lo dado a cuenta <em>· disponible ${money(credit)}</em></span><input type="number" name="advance" min="0" max="${credit}" step="1" value="0" data-auto="1"></label></div>` : ""}
    <div class="form-grid col-pay-meta">
      <label>Fecha del pago<input name="paid_on" type="date" value="${today()}" required></label>
      <label>Nota (opcional)<input name="notes" maxlength="140" placeholder="Ej. Transferencia"></label>
    </div>
    <div class="col-pay-total"><div><span>Eventos</span><strong data-col-pay="gross">$ 0</strong></div><div><span>Descuentos</span><strong data-col-pay="disc">$ 0</strong></div>${credit > 0 ? `<div><span>A cuenta</span><strong data-col-pay="adv">$ 0</strong></div>` : ""}<div class="col-pay-net"><span>A pagar</span><strong data-col-pay="net">$ 0</strong></div></div>
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
  const advInput = form.querySelector("input[name=advance]");
  // Lo dado a cuenta se descuenta solo (hasta cubrir lo que se paga), salvo que lo cambies a mano.
  const advMax = advInput ? Number(advInput.getAttribute("max")) || 0 : 0;
  if (advInput && advInput.getAttribute("data-auto") === "1") advInput.value = String(num(Math.max(0, Math.min(advMax, gross - disc))));
  const advance = advInput ? num(advInput.value) : 0;
  let error = "";
  if (discounts.some((d) => d.amount > d.max)) error = "Un descuento supera lo que queda por descontar.";
  else if (advInput && advance > advMax) error = "Lo que descontás supera lo que le diste a cuenta.";
  else if (disc + advance > gross) error = "Los descuentos y lo dado a cuenta no pueden superar lo que le pagás en este pago.";
  else if (!coverageIds.length && !disc) error = "Marcá al menos un evento.";
  return { coverageIds, gross, disc, advance, net: num(gross - disc - advance), discounts: discounts.map(({ id, amount }) => ({ id, amount })), error };
}
function updatePaymentTotals(form) {
  const v = paymentValues(form);
  form.querySelector("[data-col-pay=gross]").textContent = money(v.gross);
  form.querySelector("[data-col-pay=disc]").textContent = v.disc ? `−${money(v.disc)}` : money(0);
  const adv = form.querySelector("[data-col-pay=adv]"); if (adv) adv.textContent = v.advance ? `−${money(v.advance)}` : money(0);
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
      p_paid_on: form.elements.paid_on.value || today(), p_notes: form.elements.notes.value || null, p_advance: v.advance || 0,
    }));
    closeDialog("colFormDialog");
    await loadColleagues();
    const p = data.payments.find((x) => x.id === paymentId);
    toast(`Pago registrado: ${money(v.net)}`);
    if (p && colleagueById(colleagueId)?.phone && confirm("Pago registrado. ¿Le mandás el detalle por WhatsApp?")) sendWhatsapp(colleagueById(colleagueId), paymentMessage(p));
  });
}
// Pago a cuenta (parcial / adelanto): no paga eventos puntuales; se resta de
// lo que se le debe y se descuenta cuando se le pagan los eventos.
function openAdvanceForm(colleagueId) {
  const c = colleagueById(colleagueId); if (!c) return;
  const s = summary(c);
  showDialog("colFormDialog", `<form id="colAdvanceForm" data-colleague="${colleagueId}">
    ${head(c.name, "Pago a cuenta (parcial)", "colFormDialog")}
    <p class="col-help">Anotá lo que le das ahora aunque no cubra eventos completos. Se resta de lo que le debés y, cuando le pagues los eventos, se descuenta solo.</p>
    <div class="col-pay-total"><div><span>Le debés hoy</span><strong>${money(s.net)}</strong></div><div><span>Ya dado a cuenta</span><strong>${money(s.credit)}</strong></div><div><span>Eventos futuros</span><strong>${money(s.future)}</strong></div></div>
    <div class="form-grid">
      <label>Monto que le das<input name="amount" type="number" min="1" step="1" inputmode="numeric" required placeholder="Ej. 50000"></label>
      <label>Fecha<input name="paid_on" type="date" value="${today()}" required></label>
    </div>
    <label class="full-label">Nota (opcional)<input name="notes" maxlength="140" placeholder="Ej. Transferencia, a cuenta de la boda del sábado"></label>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" data-col="close" data-id="colFormDialog">Cancelar</button>
      <button class="primary-btn" type="submit">Registrar pago a cuenta</button>
    </div>
  </form>`);
}
async function saveAdvanceForm(form) {
  const colleagueId = form.dataset.colleague;
  const amount = num(form.elements.amount.value);
  if (!(amount > 0)) { toast("Poné el monto que le das."); return; }
  await withBusy(form, async () => {
    const [p] = await run(supabase.from("colleague_payments").insert({
      colleague_id: colleagueId, kind: "advance", gross: 0, discounts: 0, net: amount,
      paid_on: form.elements.paid_on.value || today(), notes: String(form.elements.notes.value || "").trim() || null,
    }).select());
    closeDialog("colFormDialog");
    await loadColleagues();
    toast(`Pago a cuenta registrado: ${money(amount)}`);
    const c = colleagueById(colleagueId);
    if (p && c?.phone && confirm("Pago a cuenta registrado. ¿Le mandás el detalle por WhatsApp?")) sendWhatsapp(c, paymentMessage(data.payments.find((x) => x.id === p.id) || p));
  });
}

async function undoPayment(id) {
  const p = data.payments.find((x) => x.id === id); if (!p) return;
  if (p.kind === "advance" && advanceCredit(p.colleague_id) < Number(p.net)) { toast("Ese pago a cuenta ya se descontó en un pago de eventos posterior: deshacé primero ese pago.", 7000); return; }
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

// ── acceso al portal de colegas (/colega.html) ────────────────────────────
const PORTAL_URL = `${PRODUCTION_ORIGIN}/colega.html`;
function openAccessDialog(id, creds = null) {
  const c = colleagueById(id); if (!c) return;
  const msg = creds ? [
    `Hola ${firstName(c.name)}! Ya tenés tu acceso a Janos Control para ver tus eventos, las tareas de tu salón y dejar notas:`,
    "", PORTAL_URL, "", `Usuario: ${creds.email}`, `Contraseña: ${creds.password}`, "",
    "Guardá el link en tu celular. Es personal, no lo compartas 🙌",
  ].join("\n") : "";
  showDialog("colFormDialog", `<div class="col-cal">
    ${head(c.name, "Acceso al portal de colegas", "colFormDialog")}
    <p class="col-help">Entra en <b>${esc(PORTAL_URL)}</b> con su Gmail. Ve los eventos que cubre y los de sus salones (${esc((c.salons || []).join(", ") || "sin salón asignado")}), con tareas y notas, <b>sin montos ni pagos</b>. No puede entrar a tu Janos Control.</p>
    ${!c.email ? `<div class="col-warn">Cargale el Gmail en su ficha (✎) antes de crear el acceso: es su usuario.</div>` : ""}
    ${creds ? `<div class="col-warn">Guardá o mandá estos datos ahora: la contraseña no se vuelve a mostrar.</div>
      <label class="full-label">Mensaje para mandarle<textarea readonly rows="8" data-col-access-msg>${esc(msg)}</textarea></label>` : `<p class="col-help">Estado: ${c.user_id ? `<b>tiene acceso</b> (usuario ${esc(c.email || "")})` : "<b>sin acceso todavía</b>"}.</p>`}
    <div class="modal-actions col-cal-actions">
      ${c.user_id ? `<button class="danger-btn" type="button" data-col="access-revoke" data-id="${c.id}">Quitar acceso</button><button class="ghost-btn" type="button" data-col="access-reset" data-id="${c.id}">Nueva contraseña</button>` : `<button class="primary-btn" type="button" data-col="access-create" data-id="${c.id}" ${c.email && c.active ? "" : "disabled"}>Crear acceso</button>`}
      ${creds ? `<button class="secondary-btn" type="button" data-col="access-copy">Copiar</button><button class="primary-btn" type="button" data-col="access-wa" data-id="${c.id}">💬 Mandar por WhatsApp</button>` : ""}
    </div>
  </div>`);
}
async function accessRequest(action, id) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Volvé a iniciar sesión.");
  const res = await fetch("/api/colleague-access", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, colleagueId: id }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "No se pudo actualizar el acceso.");
  const [fresh] = await run(supabase.from("colleagues").select("*").eq("id", id));
  if (fresh) data.colleagues = data.colleagues.map((c) => (c.id === id ? fresh : c));
  renderColleagues();
  if (action === "revoke") { toast("Acceso quitado"); openAccessDialog(id); return; }
  toast(action === "create" ? "Acceso creado" : "Contraseña nueva generada");
  openAccessDialog(id, { email: out.email, password: out.password });
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
  advance: (id) => openAdvanceForm(id),
  "add-discount": (id) => openDiscountForm(id),
  "del-discount": (id) => deleteDiscount(id),
  "edit-discount": (id) => { const d = data.discounts.find((x) => x.id === id); if (d) openDiscountForm(d.colleague_id, d); },
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
  "repl-keep": (id) => keepCoverage(id),
  "assign-when": (w) => { assignWhen = w === "past" ? "past" : "upcoming"; assignMonth = ""; renderColleagues(); },
  "assign-kind": (k) => { assignKind = k === "session" ? "session" : "event"; renderColleagues(); },
  "gcal-reload": () => loadGcalSessions(),
  "session-sync": (id) => syncSessionCoverage(id),
  mode: (m) => { colMode = m === "assign" ? "assign" : "team"; try { localStorage.setItem(MODE_KEY, colMode); } catch {} renderColleagues(); },
  team: (t) => { teamFilter = t || "Pablo"; try { localStorage.setItem(TEAM_KEY, teamFilter); } catch {} renderColleagues(); },
  "notify-wa": (id) => { const c = colleagueById(id); if (c && pendingWa[id]) { sendWhatsapp(c, pendingWa[id]); delete pendingWa[id]; } },
  "assign-session": (clientId) => { if (status !== "ready") { toast("Esperá que terminen de cargar los colegas."); return; } openCoverageForm(clientId, null, "session"); },
  "mark-confirm": (taskId) => confirmMark(taskId),
  "mark-discard": (taskId) => discardMark(taskId),
  "note-delete": (id) => deleteNote(id),
  access: (id) => openAccessDialog(id),
  "access-create": (id) => accessRequest("create", id),
  "access-reset": (id) => { if (confirm("¿Generarle una contraseña nueva? La anterior deja de funcionar.")) return accessRequest("reset", id); },
  "access-revoke": (id) => { if (confirm("¿Quitarle el acceso al portal? Ya no va a poder entrar.")) return accessRequest("revoke", id); },
  "access-copy": async () => { const v = document.querySelector("[data-col-access-msg]")?.value; try { await navigator.clipboard.writeText(v); toast("Copiado"); } catch { toast("No se pudo copiar: seleccionalo y copialo a mano"); } },
  "access-wa": (id) => { const c = colleagueById(id); const v = document.querySelector("[data-col-access-msg]")?.value; if (c && v) sendWhatsapp(c, v); },
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
    if (e.target.matches("#colColleagueForm input[name=task_keys]")) { const n = e.target.form.querySelectorAll("input[name=task_keys]:checked").length; const b = e.target.form.querySelector("[data-col-taskkeys-count]"); if (b) b.textContent = n; }
    if (e.target.matches("[data-col-toggle-inactive]")) { showInactive = e.target.checked; renderColleagues(); }
    if (e.target.matches("[data-col-assign]")) assignFromSelector(e.target);
    if (e.target.matches("[data-col-replace]")) {
      const cv = data.coverages.find((x) => x.id === e.target.dataset.colReplace);
      if (e.target.value === "__ext") { if (cv) openExternalForm(cv.client_id, cv.kind || "event", cv.id); }
      else if (e.target.value) { e.target.disabled = true; replaceCoverage(e.target.dataset.colReplace, e.target.value); }
    }
    if (e.target.matches("[data-col-assign-filter]")) {
      const k = e.target.dataset.colAssignFilter;
      if (k === "month") assignMonth = e.target.value;
      if (k === "salon") assignSalon = e.target.value;
      if (k === "free") assignOnlyFree = e.target.checked;
      renderColleagues();
    }
    if (e.target.matches("#colCoverageForm select[name=colleague_id]")) onCoverageColleagueChange(e.target);
    if (e.target.matches("[data-col-event-time]")) onEventTimeInput(e.target);
  });
  document.addEventListener("input", (e) => {
    const form = e.target.form;
    if (form?.id === "colPaymentForm" && e.target.name === "advance") e.target.setAttribute("data-auto", "0");
    if (form?.id === "colPaymentForm") updatePaymentTotals(form);
    if (form?.id === "colDiscountForm") updateDiscountHelp(form);
    if (form?.id === "colCoverageForm" && e.target.name === "amount") e.target.dataset.auto = "0";
    if (form?.id === "colCoverageForm" && e.target.name === "arrival_time") e.target.dataset.auto = "0";
    if (form?.id === "colCoverageForm" && e.target.name === "event_time") {
      const arrival = form.elements.arrival_time;
      if (e.target.value && (arrival.dataset.auto === "1" || !arrival.value)) { arrival.value = minusMinutes(e.target.value, ARRIVAL_BEFORE_MIN); arrival.dataset.auto = "1"; }
    }
  });
  document.addEventListener("submit", (e) => {
    const handlers = { colAdvanceForm: saveAdvanceForm, colExternalForm: saveExternalForm, colColleagueForm: saveColleagueForm, colCoverageForm: saveCoverageForm, colDiscountForm: saveDiscountForm, colPaymentForm: savePaymentForm };
    const handler = handlers[e.target.id];
    if (!handler) return;
    e.preventDefault();
    handler(e.target);
  });
}
