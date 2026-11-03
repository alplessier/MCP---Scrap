// Synchronisation du foyer avec un compte (Supabase) : un compte par foyer, connexion par lien reçu par e-mail.
//
// Les données restent d'abord dans le navigateur (le site marche sans compte ni réseau). Connecté, l'état est
// envoyé quelques secondes après chaque changement et relu à l'ouverture ou au retour sur l'onglet. La
// première connexion d'un appareil réunit ses données et celles du compte (Core.mergeSyncData) ; ensuite, la
// version la plus récente l'emporte. La clé ci-dessous est la clé publique : les règles de la base (voir
// supabase/schema.sql) limitent chaque compte à sa propre ligne.
"use strict";

const SUPABASE_URL = "https://vradxzmaknbunhumchvo.supabase.co";
const SUPABASE_KEY = "sb_publishable_PKO5abobCLSJhQJHHh6l5Q_7Lu6-6eY";
// Ce qui suit le foyer d'un appareil à l'autre (le reste de l'état est propre à chaque navigateur)
const SYNC_KEYS = ["members", "foyer", "rankFor", "group", "custom", "favs", "plan", "menu", "pins", "owned", "prefProducts",
  "unavailable", "pantryBuy", "formatKeep", "fridge", "strategy", "keepAwake", "draft", "lastCart"];
const PUSH_DELAY = 2500;
const PULL_EVERY = 30000;

const sync = { client: null, user: null, status: "", busy: false, pushTimer: null, lastPull: 0, applying: false };

function syncClient() {
  if (!sync.client && window.supabase && window.supabase.createClient) {
    sync.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      // flux « implicite » : le lien fonctionne même ouvert dans un autre navigateur que celui de la demande
      auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true, storageKey: "recette-macros:compte" },
    });
  }
  return sync.client;
}

const syncPayload = () => Object.fromEntries(SYNC_KEYS.filter((k) => k in state).map((k) => [k, state[k]]));
const syncMeta = () => (state.sync = state.sync || {});

// Remplace l'état local par celui du compte (sans le marquer comme modifié ici)
function applyRemote(data) {
  sync.applying = true;
  for (const k of SYNC_KEYS) if (k in data) state[k] = data[k];
  state.members = (state.members || []).map((m) => newMember(m));
  if (!state.members.length) state.members = [newMember()];
  productsChanged();
  sync.applying = false;
}

function setSyncStatus(text) {
  sync.status = text;
  const el = document.getElementById("sync-status");
  if (el) el.textContent = text;
}

async function syncPush() {
  const client = syncClient();
  if (!client || !sync.user) return;
  const at = new Date().toISOString();
  const { error } = await client.from("foyers").upsert({ user_id: sync.user.id, data: syncPayload(), updated_at: at });
  if (error) return setSyncStatus(`⚠️ Envoi impossible : ${error.message}`);
  const meta = syncMeta();
  meta.syncedAt = Date.parse(at);
  meta.updatedAt = meta.syncedAt;
  meta.email = sync.user.email;
  persistState();
  setSyncStatus(`✓ Synchronisé à ${new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`);
}

async function syncPull() {
  const client = syncClient();
  if (!client || !sync.user || sync.busy) return;
  sync.busy = true;
  sync.lastPull = Date.now();
  try {
    const { data, error } = await client.from("foyers").select("data, updated_at").eq("user_id", sync.user.id).maybeSingle();
    if (error) { setSyncStatus(`⚠️ Lecture impossible : ${error.message}`); return; }
    const meta = syncMeta();
    if (!data) { await syncPush(); return; } // premier appareil du compte
    const remoteAt = Date.parse(data.updated_at);
    if (!meta.syncedAt || meta.email !== sync.user.email) {
      // premier passage de cet appareil : on réunit ses données et celles du compte
      const local = syncPayload(), remote = data.data || {};
      // le profil vierge créé par défaut sur cet appareil ne double pas ceux du compte
      if ((remote.members || []).length) local.members = (local.members || []).filter((m) => (m.name || "").trim());
      applyRemote(C.mergeSyncData(local, remote));
      await syncPush();
      toast("☁️ Vos données sont réunies et synchronisées.");
      render({ keepScroll: true });
    } else if (remoteAt > (meta.updatedAt || 0)) {
      applyRemote(data.data || {});
      meta.syncedAt = meta.updatedAt = remoteAt;
      persistState();
      setSyncStatus(`✓ À jour (modifié ailleurs à ${new Date(remoteAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })})`);
      render({ keepScroll: true });
    } else if ((meta.updatedAt || 0) > (meta.syncedAt || 0)) {
      await syncPush();
    } else {
      setSyncStatus("✓ À jour");
    }
  } catch (e) {
    setSyncStatus("⚠️ Hors ligne : les changements seront envoyés plus tard.");
  } finally {
    sync.busy = false;
  }
}

// Appelé par save() à chaque changement
function syncSoon() {
  if (sync.applying) return;
  syncMeta().updatedAt = Date.now();
  persistState();
  if (!sync.user) return;
  clearTimeout(sync.pushTimer);
  setSyncStatus("… envoi en attente");
  sync.pushTimer = setTimeout(() => syncPush().catch(() => setSyncStatus("⚠️ Hors ligne : nouvel essai bientôt.")), PUSH_DELAY);
}

async function syncLogin(email) {
  const client = syncClient();
  if (!client) return toast("Service de synchronisation indisponible.");
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
  if (error) return toast(`Envoi impossible : ${error.message}`);
  toast(`📧 Lien de connexion envoyé à ${email}. Ouvrez-le sur cet appareil.`);
}

async function syncLogout() {
  const client = syncClient();
  if (client) await client.auth.signOut();
  sync.user = null;
  delete syncMeta().syncedAt;
  persistState();
  toast("Déconnecté. Vos données restent sur cet appareil.");
  render({ keepScroll: true });
}

function syncPanel() {
  if (!syncClient()) return "";
  if (!sync.user) {
    return `<div class="panel sync-panel">
      <h2>☁️ Compte du foyer</h2>
      <p class="muted">Connectez-vous pour retrouver profils, recettes, favoris et planning sur tous vos appareils (téléphone, ordinateur…). Un seul compte pour tout le foyer.</p>
      <form class="sync-form" data-action="sync-login">
        <input type="email" id="sync-email" required autocomplete="email" placeholder="votre@adresse.fr" aria-label="Adresse e-mail du foyer">
        <button class="btn primary" type="submit">Recevoir le lien de connexion</button>
      </form>
      <p class="hint">Pas de mot de passe : vous recevez un lien par e-mail. Sans compte, tout reste enregistré dans ce navigateur, comme aujourd'hui.</p>
    </div>`;
  }
  return `<div class="panel sync-panel">
    <h2>☁️ Compte du foyer</h2>
    <p>Connecté : <b>${esc(sync.user.email)}</b></p>
    <p class="muted" id="sync-status">${esc(sync.status || "")}</p>
    <div class="actions">
      <button class="btn" data-action="sync-now">🔄 Synchroniser maintenant</button>
      <button class="btn ghost" data-action="sync-logout">Se déconnecter</button>
    </div>
    <p class="hint">Les changements partent quelques secondes après chaque modification et arrivent sur vos autres appareils à leur ouverture.</p>
  </div>`;
}

async function syncInit() {
  const client = syncClient();
  const linkHash = /access_token=|error_description=/.test(location.hash) ? location.hash : "";
  if (!client) { if (linkHash) location.replace("#/profil"); return; }
  client.auth.onAuthStateChange((event, session) => {
    const was = sync.user && sync.user.id;
    sync.user = session ? session.user : null;
    if (sync.user && sync.user.id !== was) {
      if (event === "SIGNED_IN") toast(`☁️ Connecté : ${sync.user.email}`);
      setTimeout(() => syncPull(), 0);
    }
    if (/^#\/profil/.test(location.hash)) render({ keepScroll: true });
  });
  // retour du lien de connexion : la session est dans l'adresse (#access_token=…), on revient au profil
  const { data } = await client.auth.getSession();
  if (linkHash) {
    const err = new URLSearchParams(linkHash.slice(1)).get("error_description");
    if (err) toast(`Lien de connexion refusé : ${err} (il n'est valable qu'une fois et expire au bout d'une heure).`);
    location.replace("#/profil");
  }
  if (data && data.session && !sync.user) { sync.user = data.session.user; syncPull(); }
}

document.addEventListener("submit", (e) => {
  if (e.target.dataset.action !== "sync-login") return;
  e.preventDefault();
  const email = document.getElementById("sync-email").value.trim();
  if (email) syncLogin(email);
});
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "sync-now") { setSyncStatus("… synchronisation"); syncPull(); }
  if (el.dataset.action === "sync-logout") syncLogout();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - sync.lastPull > PULL_EVERY) syncPull();
});

syncInit();
