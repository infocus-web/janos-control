import { createClient } from "@supabase/supabase-js";

// Portal de colegas (/colega.html). La colega entra con su Gmail y la
// contraseña que le generó el dueño (/api/colleague-access).
//
// POST { action, ... }
//  - login   { email, password }   → { session }   (solo si es colega activa)
//  - refresh { refresh_token }     → { session }
//  - data                          → sus coberturas + eventos de sus salones
//  - mark    { taskId, done }      → marca/desmarca una tarea como hecha
//  - note    { clientId, body }    → agrega una nota al evento
//  - unnote  { noteId }            → borra una nota suya
// (data/mark/note/unnote van con Authorization: Bearer <access_token>)
//
// Reglas (todo se filtra acá, con service role):
//  - ve los eventos del MISMO dueño que cubre ella o que son de sus salones,
//    desde 60 días atrás;
//  - nunca recibe montos, tarifas, pagos ni rendiciones;
//  - lo que marca/escribe va a colleague_task_marks / colleague_notes (no
//    toca tasks ni clients: el dueño confirma desde su app).

const PAST_DAYS = 60;
const CLIENT_FIELDS = "id,code,event_date,salon,event_type,honoree,client_name,client_phone,client_email,guests,pack,addons,notes,whatsapp_group_url,drive_url";
const TASK_FIELDS = "id,client_id,title,phase,status,completed_at,responsible,notes,sort_order";

function send(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify(body));
}
function sinceIso() { return new Date(Date.now() - 3 * 3600000 - PAST_DAYS * 86400000).toISOString().slice(0, 10); }
function publicSession(s) { return s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at } : null; }
function hhmm(t) { return t ? String(t).slice(0, 5) : ""; }

async function colleagueForUser(admin, userId) {
  const { data, error } = await admin.from("colleagues").select("id,owner_id,name,role,salons,active").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data && data.active ? data : null;
}

// Puede ver/editar este evento: es del mismo dueño y lo cubre o es de su salón.
async function canSeeClient(admin, colleague, clientId) {
  const { data: client } = await admin.from("clients").select("id,owner_id,salon").eq("id", clientId).maybeSingle();
  if (!client || client.owner_id !== colleague.owner_id) return null;
  if ((colleague.salons || []).includes(client.salon)) return client;
  const { data: cov } = await admin.from("colleague_coverages").select("id").eq("client_id", clientId).eq("colleague_id", colleague.id).limit(1);
  return cov?.length ? client : null;
}

async function loadData(admin, colleague) {
  const since = sinceIso();
  const { data: covRows, error: covError } = await admin
    .from("colleague_coverages")
    .select("id,client_id,kind,work_date,role,arrival_time,end_time,location,notes,drive_shared_at,clients!inner(event_date)")
    .eq("colleague_id", colleague.id)
    .gte("clients.event_date", since);
  if (covError) throw covError;
  const coverages = covRows || [];

  const ids = new Set(coverages.map((c) => c.client_id));
  let salonClients = [];
  if ((colleague.salons || []).length) {
    const { data, error } = await admin.from("clients").select("id").eq("owner_id", colleague.owner_id).in("salon", colleague.salons).gte("event_date", since).limit(1000);
    if (error) throw error;
    salonClients = data || [];
  }
  salonClients.forEach((c) => ids.add(c.id));
  const clientIds = [...ids];
  if (!clientIds.length) return { clients: [], tasks: [], notes: [], marks: [] };

  const chunks = [];
  for (let i = 0; i < clientIds.length; i += 200) chunks.push(clientIds.slice(i, i + 200));
  const pick = async (table, fields, extra = (q) => q) => {
    const out = [];
    for (const chunk of chunks) {
      const { data, error } = await extra(admin.from(table).select(fields).in(table === "clients" ? "id" : "client_id", chunk));
      if (error) throw error;
      out.push(...(data || []));
    }
    return out;
  };
  const [clients, tasks, notes, marks] = await Promise.all([
    pick("clients", CLIENT_FIELDS, (q) => q.eq("owner_id", colleague.owner_id)),
    pick("tasks", TASK_FIELDS, (q) => q.eq("owner_id", colleague.owner_id)),
    pick("colleague_notes", "id,client_id,body,author_name,created_at", (q) => q.eq("colleague_id", colleague.id)),
    pick("colleague_task_marks", "task_id,client_id,author_name,colleague_id,done_at", (q) => q.eq("owner_id", colleague.owner_id)),
  ]);

  return {
    clients: clients.map((c) => {
      const mine = coverages.filter((cv) => cv.client_id === c.id);
      return {
        ...c,
        // La carpeta solo sirve si ya se la compartieron (si no, no tiene permiso).
        drive_url: mine.some((cv) => cv.drive_shared_at) ? c.drive_url : null,
        // Evento y/o sesión de fotos que cubre ella (la sesión tiene su fecha).
        coverages: mine.map((cv) => ({ kind: cv.kind || "event", date: cv.work_date || c.event_date, role: cv.role, arrival: hhmm(cv.arrival_time), end: hhmm(cv.end_time), location: cv.location, notes: cv.notes })),
      };
    }),
    tasks,
    notes,
    marks: marks.map((m) => ({ task_id: m.task_id, author_name: m.author_name, done_at: m.done_at, mine: m.colleague_id === colleague.id })),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return send(res, 500, { error: "Falta SUPABASE_SERVICE_ROLE_KEY en Vercel" });
    const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const anon = () => createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { action } = body;

    if (action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) return send(res, 400, { error: "Poné tu Gmail y tu contraseña." });
      const { data, error } = await anon().auth.signInWithPassword({ email, password });
      if (error || !data?.session) return send(res, 401, { error: "Gmail o contraseña incorrectos." });
      const colleague = await colleagueForUser(admin, data.user.id);
      if (!colleague) return send(res, 403, { error: "Este usuario no tiene acceso de colega. Pedile a Pablo que te lo active." });
      return send(res, 200, { session: publicSession(data.session), name: colleague.name });
    }
    if (action === "refresh") {
      const { data, error } = await anon().auth.refreshSession({ refresh_token: String(body.refresh_token || "") });
      if (error || !data?.session) return send(res, 401, { error: "Volvé a entrar." });
      return send(res, 200, { session: publicSession(data.session) });
    }

    const authHeader = String(req.headers.authorization || req.headers.Authorization || "");
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return send(res, 401, { error: "Volvé a entrar." });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return send(res, 401, { error: "Volvé a entrar." });
    const colleague = await colleagueForUser(admin, userData.user.id);
    if (!colleague) return send(res, 403, { error: "Tu acceso de colega no está activo. Hablá con Pablo." });

    if (action === "data") {
      const out = await loadData(admin, colleague);
      return send(res, 200, { me: { name: colleague.name, role: colleague.role, salons: colleague.salons || [] }, ...out });
    }

    if (action === "mark") {
      const { data: task } = await admin.from("tasks").select("id,client_id,owner_id,status").eq("id", String(body.taskId || "")).maybeSingle();
      if (!task || task.owner_id !== colleague.owner_id || !(await canSeeClient(admin, colleague, task.client_id))) return send(res, 404, { error: "Tarea no encontrada." });
      if (body.done) {
        if (task.status === "done") return send(res, 200, { ok: true });
        const { error } = await admin.from("colleague_task_marks").upsert({ task_id: task.id, owner_id: colleague.owner_id, client_id: task.client_id, colleague_id: colleague.id, author_name: colleague.name, done_at: new Date().toISOString() }, { onConflict: "task_id", ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const { error } = await admin.from("colleague_task_marks").delete().eq("task_id", task.id).eq("colleague_id", colleague.id);
        if (error) throw error;
      }
      return send(res, 200, { ok: true });
    }

    if (action === "note") {
      const text = String(body.body || "").trim().slice(0, 2000);
      if (!text) return send(res, 400, { error: "La nota está vacía." });
      const client = await canSeeClient(admin, colleague, String(body.clientId || ""));
      if (!client) return send(res, 404, { error: "Evento no encontrado." });
      const { data, error } = await admin.from("colleague_notes").insert({ owner_id: colleague.owner_id, client_id: client.id, colleague_id: colleague.id, author_name: colleague.name, body: text }).select("id,client_id,body,author_name,created_at").single();
      if (error) throw error;
      return send(res, 200, { ok: true, note: data });
    }

    if (action === "unnote") {
      const { error } = await admin.from("colleague_notes").delete().eq("id", String(body.noteId || "")).eq("colleague_id", colleague.id);
      if (error) throw error;
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { error: "Pedido inválido" });
  } catch (err) {
    console.error("colleague-portal error:", err);
    return send(res, 500, { error: "Algo falló. Probá de nuevo en un rato." });
  }
}
