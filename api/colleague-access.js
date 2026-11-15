import { createClient } from "@supabase/supabase-js";
import { randomInt } from "node:crypto";

// Acceso de una colega al portal (/colega.html). Lo usa SOLO el dueño desde
// Janos Control.
//
// POST { action: "create" | "reset" | "revoke", colleagueId }
//  - create: crea el usuario (Gmail de la ficha + contraseña generada) y lo
//            vincula a la colega. Devuelve { email, password } para
//            mandárselo por WhatsApp (no depende de mails de Resend).
//  - reset:  le pone una contraseña nueva (y actualiza el Gmail si cambió).
//  - revoke: la desvincula y bloquea el usuario; deja de poder entrar.
//
// La colega se lee con el JWT del dueño (RLS: solo ve las suyas). La
// service role se usa para crear/editar el usuario en Auth y guardar
// colleagues.user_id. El usuario nuevo queda con profiles.status =
// "blocked" (lo crea el trigger), así NO puede entrar a Janos Control:
// solo al portal, que valida el vínculo en /api/colleague-portal.

const WORDS = ["foto", "luz", "flash", "lente", "click", "album", "rollo", "zoom", "color", "salon"];
function newPassword() {
  return `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${randomInt(1000, 10000)}`;
}
function send(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader) return send(res, 401, { error: "No autorizado" });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return send(res, 500, { error: "Falta SUPABASE_SERVICE_ROLE_KEY en Vercel" });

    const asOwner = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await asOwner.auth.getUser();
    if (userError || !userData?.user) return send(res, 401, { error: "No autorizado" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { action, colleagueId } = body;
    if (!["create", "reset", "revoke"].includes(action) || !colleagueId) return send(res, 400, { error: "Pedido inválido" });

    // RLS: si no es del dueño (o el dueño no está activo) no la encuentra.
    const { data: colleague, error: colError } = await asOwner
      .from("colleagues").select("id,owner_id,name,email,active,user_id").eq("id", colleagueId).maybeSingle();
    if (colError) return send(res, 500, { error: colError.message });
    if (!colleague) return send(res, 404, { error: "Colega no encontrada" });

    const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    if (action === "revoke") {
      if (colleague.user_id) {
        await admin.auth.admin.updateUserById(colleague.user_id, { ban_duration: "876000h" }).catch(() => {});
        const { error } = await admin.from("colleagues").update({ user_id: null }).eq("id", colleague.id);
        if (error) return send(res, 500, { error: error.message });
      }
      return send(res, 200, { ok: true });
    }

    if (!colleague.active) return send(res, 400, { error: "La colega está inactiva. Activala para darle acceso." });
    const email = String(colleague.email || "").trim().toLowerCase();
    if (!email) return send(res, 400, { error: `Cargale el Gmail a ${colleague.name} en su ficha: es su usuario para entrar.` });
    const password = newPassword();

    if (action === "reset") {
      if (!colleague.user_id) return send(res, 400, { error: "Todavía no tiene acceso creado." });
      const { error } = await admin.auth.admin.updateUserById(colleague.user_id, { email, email_confirm: true, password, ban_duration: "none" });
      if (error) return send(res, 400, { error: /already|registered|exists/i.test(error.message) ? "Ese Gmail ya lo usa otra cuenta." : error.message });
      return send(res, 200, { ok: true, email, password });
    }

    // create
    if (colleague.user_id) return send(res, 400, { error: "Ya tiene acceso. Usá «Nueva contraseña» si no puede entrar." });
    let userId = null;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: colleague.name, janos_colleague: true },
    });
    if (createError) {
      if (!/already|registered|exists/i.test(createError.message)) return send(res, 400, { error: createError.message });
      // El Gmail ya tiene usuario: solo lo reuso si es una cuenta de colega
      // (nunca una cuenta real de Janos Control de otra persona).
      const { data: prof } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      const existing = prof?.id ? (await admin.auth.admin.getUserById(prof.id)).data?.user : null;
      if (!existing || existing.user_metadata?.janos_colleague !== true) {
        return send(res, 400, { error: "Ese Gmail ya tiene una cuenta propia en Janos Control. Usá otro Gmail para el acceso de colega." });
      }
      const { data: other } = await admin.from("colleagues").select("id").eq("user_id", existing.id).maybeSingle();
      if (other && other.id !== colleague.id) return send(res, 400, { error: "Ese Gmail ya es el acceso de otra colega." });
      const { error: updError } = await admin.auth.admin.updateUserById(existing.id, { password, ban_duration: "none" });
      if (updError) return send(res, 400, { error: updError.message });
      userId = existing.id;
    } else {
      userId = created.user.id;
    }
    const { error: linkError } = await admin.from("colleagues").update({ user_id: userId }).eq("id", colleague.id);
    if (linkError) return send(res, 500, { error: linkError.message });
    return send(res, 200, { ok: true, email, password });
  } catch (err) {
    console.error("colleague-access error:", err);
    return send(res, 500, { error: String(err?.message || "Error interno del servidor") });
  }
}
