import { createClient } from "@supabase/supabase-js";

// Calendario privado de un colega: GET /api/colleague-calendar?token=…
//  - Sin más parámetros devuelve un feed .ics (iPhone/Google Calendar se
//    suscriben y se actualiza solo).
//  - Con &page=1 devuelve una página para abrir desde el celular, con los
//    próximos eventos y los botones para agregar el calendario.
// Reglas:
//  - el token es la "llave": quien lo tenga ve los eventos de ESE colega.
//    "Generar link nuevo" en la app lo cambia y el anterior deja de andar.
//  - solo se muestran sus eventos (desde 90 días atrás), sin montos ni
//    datos de contacto del cliente.
//  - un colega desactivado no tiene calendario.
// Usa VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ya cargadas en Vercel).

const TZ_OFFSET = 3; // Argentina: UTC-3 todo el año (sin horario de verano)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeIcs(v) { return String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function fold(line) { const out = []; let s = line; while (Buffer.byteLength(s, "utf8") > 74) { let cut = 74; while (Buffer.byteLength(s.slice(0, cut), "utf8") > 74) cut--; out.push(s.slice(0, cut)); s = ` ${s.slice(cut)}`; } out.push(s); return out.join("\r\n"); }
function escapeHtml(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function hhmm(t) { return t ? String(t).slice(0, 5) : ""; }
function utcStamp(date, time, addDays = 0) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + addDays, hh + TZ_OFFSET, mm));
  return dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function dayStamp(date, addDays = 0) { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + addDays)).toISOString().slice(0, 10).replace(/-/g, ""); }
function todayAr() { return new Date(Date.now() - TZ_OFFSET * 3600000).toISOString().slice(0, 10); }
function dateLong(iso) { const s = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`)); return s.charAt(0).toUpperCase() + s.slice(1); }

function eventTitle(cv) { const c = cv.clients; return `${c.honoree || "Evento"}${c.event_type ? ` (${c.event_type})` : ""} · ${c.salon || ""}`.trim(); }
function driveLink(cv) { return cv.drive_shared_at && cv.clients.drive_url ? cv.clients.drive_url : ""; }

export function buildCalendar(colleague, coverages) {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Janos Control//Coberturas//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(`Coberturas · ${colleague.name}`)}`, "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
    "REFRESH-INTERVAL;VALUE=DURATION:PT2H", "X-PUBLISHED-TTL:PT2H",
  ];
  for (const cv of coverages) {
    const date = cv.clients.event_date;
    if (!date) continue;
    const desc = [
      cv.arrival_time ? `Presentarse: ${hhmm(cv.arrival_time)} h${cv.end_time ? ` (hasta ${hhmm(cv.end_time)} h)` : ""}` : "",
      cv.role ? `Función: ${cv.role}` : "",
      cv.location ? `Lugar: ${cv.location}` : "",
      cv.notes ? `Indicaciones: ${cv.notes}` : "",
      driveLink(cv) ? `Subí las fotos a la carpeta FOTOS: ${driveLink(cv)}` : "",
    ].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${cv.id}@janos-control`, `DTSTAMP:${now}`, `LAST-MODIFIED:${String(cv.updated_at || "").replace(/[-:]/g, "").replace(/\.\d+/, "").replace(/\+00$/, "Z").replace(/\+0000$/, "Z") || now}`);
    if (cv.arrival_time) {
      const start = hhmm(cv.arrival_time);
      const end = cv.end_time ? hhmm(cv.end_time) : null;
      lines.push(`DTSTART:${utcStamp(date, start)}`);
      if (end) lines.push(`DTEND:${utcStamp(date, end, end <= start ? 1 : 0)}`);
      else lines.push("DURATION:PT6H");
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dayStamp(date)}`, `DTEND;VALUE=DATE:${dayStamp(date, 1)}`);
    }
    lines.push(`SUMMARY:${escapeIcs(eventTitle(cv))}`);
    if (cv.location || cv.clients.salon) lines.push(`LOCATION:${escapeIcs(cv.location || cv.clients.salon)}`);
    if (desc) lines.push(`DESCRIPTION:${escapeIcs(desc)}`);
    if (driveLink(cv)) lines.push(`URL:${driveLink(cv)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function buildPage(colleague, coverages, origin, token, today) {
  const feed = `${origin}/api/colleague-calendar?token=${token}`;
  const webcal = feed.replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  const upcoming = coverages.filter((cv) => cv.clients.event_date >= today);
  const rows = upcoming.map((cv) => `<li>
    <div class="d">${escapeHtml(dateLong(cv.clients.event_date))}</div>
    <div class="t">${escapeHtml(eventTitle(cv))}</div>
    <div class="m">${cv.arrival_time ? `🕒 ${hhmm(cv.arrival_time)} h${cv.end_time ? ` – ${hhmm(cv.end_time)} h` : ""}` : "🕒 Horario a confirmar"}${cv.role ? ` · ${escapeHtml(cv.role)}` : ""}</div>
    ${cv.location ? `<div class="m">📍 <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cv.location)}" target="_blank" rel="noopener">${escapeHtml(cv.location)}</a></div>` : ""}
    ${cv.notes ? `<div class="m">📝 ${escapeHtml(cv.notes)}</div>` : ""}
    ${driveLink(cv) ? `<a class="drive" href="${escapeHtml(driveLink(cv))}" target="_blank" rel="noopener">📁 Subir fotos (carpeta FOTOS)</a>` : ""}
  </li>`).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Coberturas · ${escapeHtml(colleague.name)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f0a18;color:#f0eaf8}
main{max-width:560px;margin:0 auto;padding:28px 18px 48px}.eyebrow{color:#c9a84c;text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:700;margin:0}
h1{margin:6px 0 8px;font-size:24px}p{color:#c4b8d8;line-height:1.5;margin:0 0 18px}h2{font-size:15px;margin:28px 0 12px;color:#c4b8d8}
.btns{display:grid;gap:10px}.btn{display:block;text-align:center;padding:14px;border-radius:12px;font-weight:700;text-decoration:none}
.primary{background:linear-gradient(135deg,#c9a84c,#e8c97a);color:#1a1325}.secondary{background:#221932;color:#f0eaf8;border:1px solid rgba(255,255,255,.12)}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}li{background:#1a1325;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px 16px}
.d{color:#c9a84c;font-weight:700;font-size:13px}.t{font-weight:700;margin:4px 0 6px}.m{color:#c4b8d8;font-size:14px;margin-top:3px}.m a{color:#a78bfa}
.drive{display:inline-block;margin-top:10px;padding:8px 12px;border-radius:10px;background:rgba(96,165,250,.14);color:#60a5fa;font-weight:700;font-size:14px;text-decoration:none}
.empty{color:#7c6f94;text-align:center;padding:26px;border:1px dashed rgba(255,255,255,.12);border-radius:14px}
</style></head><body><main>
<p class="eyebrow">Tu calendario de coberturas</p><h1>Hola ${escapeHtml(colleague.name.split(/\s+/)[0])}!</h1>
<p>Acá tenés los eventos que cubrís, con día, hora de llegada, lugar y la carpeta para subir las fotos. Agregalos a tu calendario una sola vez y se van a actualizar solos cuando haya cambios.</p>
<div class="btns"><a class="btn primary" href="${escapeHtml(webcal)}">📱 Agregar en iPhone</a><a class="btn secondary" href="${escapeHtml(google)}" target="_blank" rel="noopener">📅 Agregar en Google Calendar</a></div>
<h2>Próximos eventos</h2>
${rows ? `<ul>${rows}</ul>` : `<div class="empty">Por ahora no tenés eventos asignados.</div>`}
</main></body></html>`;
}

function notFound(res) {
  res.status(404);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.send("Calendario no encontrado o desactivado.");
}

export default async function handler(req, res) {
  try {
    const token = String(req.query?.token || "");
    if (!UUID_RE.test(token)) return notFound(res);
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { res.status(500); return res.send("Falta SUPABASE_SERVICE_ROLE_KEY en Vercel"); }
    const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const { data: colleague, error } = await admin.from("colleagues").select("id,name,active").eq("calendar_token", token).maybeSingle();
    if (error) throw error;
    if (!colleague || !colleague.active) return notFound(res);

    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const { data: rows, error: covError } = await admin
      .from("colleague_coverages")
      .select("id,role,arrival_time,end_time,location,notes,updated_at,drive_shared_at,clients!inner(event_date,salon,honoree,event_type,drive_url)")
      .eq("colleague_id", colleague.id)
      .gte("clients.event_date", since);
    if (covError) throw covError;
    const coverages = (rows || []).filter((r) => r.clients?.event_date).sort((a, b) => a.clients.event_date.localeCompare(b.clients.event_date) || hhmm(a.arrival_time).localeCompare(hhmm(b.arrival_time)));

    if (req.query?.page) {
      res.status(200);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Robots-Tag", "noindex");
      return res.send(buildPage(colleague, coverages, `https://${req.headers?.host || "janos-control.vercel.app"}`, token, todayAr()));
    }
    res.status(200);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="coberturas.ics"');
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(buildCalendar(colleague, coverages));
  } catch (err) {
    console.error("colleague-calendar error:", err);
    res.status(500);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send("No se pudo armar el calendario.");
  }
}
