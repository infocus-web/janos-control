import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { getAccessToken } from "./_drive-auth.js";

// Da (o quita) acceso de EDITOR a un colega sobre la carpeta de Drive del
// evento que cubre: la misma carpeta que arma "Crear carpeta en Drive" en la
// ficha del cliente (clients.drive_url, con FOTOS y VIDEOS adentro). Así el
// colega entra con SU Gmail y sube las fotos, sin usar la cuenta del salón.
//
// POST { action: "share" | "unshare", coverageId }
//  - share:   crea el permiso writer para colleagues.email (Google le manda
//             un mail) y guarda drive_shared_at / drive_shared_email.
//  - unshare: borra el permiso de drive_shared_email (al quitar al colega
//             del evento o cambiarlo por otro) y limpia esas columnas.
//
// La cobertura, el colega y el cliente se leen con el JWT del usuario (RLS:
// solo ve lo suyo). La service role se usa SOLO para leer las credenciales
// de Drive de google_service_accounts (igual que create-drive-folder.js).

const CORS = {
  "Access-Control-Allow-Origin": "https://janos-control.vercel.app",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const DRIVE = "https://www.googleapis.com/drive/v3";

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function extractFolderId(url) {
  const m = String(url || "").match(/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
function driveError(data, fallback) {
  const msg = data?.error?.message || fallback;
  if (/not found/i.test(msg)) return "No encontré la carpeta en el Drive conectado (¿se borró o se movió?). Volvé a crearla desde la ficha.";
  if (/insufficient|permission/i.test(msg)) return "La cuenta de Drive conectada no tiene permiso para compartir esa carpeta.";
  if (/invalid sharing request|no google account/i.test(msg)) return "Ese mail no tiene cuenta de Google. Cargale un Gmail para poder compartirle la carpeta.";
  return msg;
}

async function listPermissions(token, folderId) {
  const res = await fetch(`${DRIVE}/files/${folderId}/permissions?${new URLSearchParams({ fields: "permissions(id,emailAddress,role,type)", supportsAllDrives: "true" })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(driveError(data, "No se pudieron leer los permisos de la carpeta"));
  return data.permissions || [];
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return json(401, { error: "No autorizado" });

    const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: authHeader } },
      realtime: { transport: ws },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) return json(401, { error: "No autorizado" });

    const { action, coverageId } = JSON.parse(event.body || "{}");
    if (!["share", "unshare"].includes(action) || !coverageId) return json(400, { error: "Pedido inválido" });

    const { data: coverage, error: covError } = await supabase
      .from("colleague_coverages")
      .select("id,owner_id,drive_shared_email,colleagues(name,email),clients(salon,drive_url,honoree,event_date)")
      .eq("id", coverageId)
      .maybeSingle();
    if (covError) return json(500, { error: covError.message });
    if (!coverage) return json(404, { error: "Cobertura no encontrada" });

    const client = coverage.clients;
    const colleague = coverage.colleagues;
    if (!client?.drive_url) {
      if (action === "unshare") return json(200, { ok: true });
      return json(400, { error: "Este evento todavía no tiene carpeta de Drive. Creala con «Crear carpeta en Drive» en la ficha del cliente y después compartila." });
    }
    const folderId = extractFolderId(client.drive_url);
    if (!folderId) return json(400, { error: "El link de Drive de este evento no es de una carpeta." });

    const email = action === "share" ? String(colleague?.email || "").trim().toLowerCase() : String(coverage.drive_shared_email || "").trim().toLowerCase();
    if (!email) {
      if (action === "unshare") return json(200, { ok: true });
      return json(400, { error: `Cargale el Gmail a ${colleague?.name || "este colega"} para compartirle la carpeta.` });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Falta la variable SUPABASE_SERVICE_ROLE_KEY en Vercel" });
    const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: credRow, error: credError } = await admin
      .from("google_service_accounts")
      .select("credentials")
      .eq("owner_id", coverage.owner_id)
      .eq("salon", client.salon)
      .maybeSingle();
    if (credError) return json(500, { error: `Error leyendo credenciales de Drive: ${credError.message}` });
    if (!credRow?.credentials) {
      return json(400, { error: `No hay una cuenta de Drive conectada para el salón "${client.salon}". Compartí la carpeta a mano con ${email} (Editor).` });
    }
    const token = await getAccessToken(credRow.credentials);

    if (action === "unshare") {
      const perms = await listPermissions(token, folderId);
      for (const p of perms.filter((x) => x.type === "user" && x.role !== "owner" && String(x.emailAddress || "").toLowerCase() === email)) {
        await fetch(`${DRIVE}/files/${folderId}/permissions/${p.id}?supportsAllDrives=true`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      }
      await supabase.from("colleague_coverages").update({ drive_shared_at: null, drive_shared_email: null }).eq("id", coverageId);
      return json(200, { ok: true });
    }

    // share: si ya tiene acceso (editor o dueño) no se crea otro permiso ni se manda otro mail.
    const perms = await listPermissions(token, folderId);
    const already = perms.find((x) => x.type === "user" && String(x.emailAddress || "").toLowerCase() === email && ["owner", "organizer", "fileOrganizer", "writer"].includes(x.role));
    if (!already) {
      const res = await fetch(`${DRIVE}/files/${folderId}/permissions?${new URLSearchParams({ sendNotificationEmail: "true", supportsAllDrives: "true", emailMessage: `Te di acceso para subir las fotos del evento ${client.honoree || ""}. Subilas a la carpeta FOTOS.`.trim() })}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user", role: "writer", emailAddress: email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json(400, { error: driveError(data, "No se pudo compartir la carpeta") });
    }

    const sharedAt = new Date().toISOString();
    const { error: updError } = await supabase.from("colleague_coverages").update({ drive_shared_at: sharedAt, drive_shared_email: email }).eq("id", coverageId);
    if (updError) return json(200, { ok: true, sharedAt, email, warning: `Se compartió, pero no se pudo guardar la marca: ${updError.message}` });
    return json(200, { ok: true, sharedAt, email });
  } catch (err) {
    console.error("colleague-drive-share error:", err);
    return json(500, { error: String(err?.message || "Error interno del servidor") });
  }
}

// Adaptador para Vercel (mismo patrón que create-drive-folder.js).
export default async function (req, res) {
  const event = {
    httpMethod: req.method,
    headers: req.headers,
    body: typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}),
  };
  const result = await handler(event);
  res.status(result.statusCode);
  for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
  res.send(result.body);
}
