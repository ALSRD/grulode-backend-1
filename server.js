const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CONEXIÓN A FIREBASE ======
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!serviceAccount.project_id) {
  console.error("❌ Falta FIREBASE_SERVICE_ACCOUNT en las variables de entorno");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

app.use(cors({ origin: true }));
app.use(express.json());

// ====== CONFIG DING ======
const DING_API_KEY = process.env.DING_API_KEY;
const DING_BASE = "https://api.dingconnect.com";

// ⚠️ IMPORTANTE: Reemplaza estos SKU con los reales de Ding (los obtienes con GetProducts)
const SKU_MAP = {
  CLARO: process.env.DING_SKU_CLARO || "",
  ALTICE: process.env.DING_SKU_ALTICE || "",
  VIVA: process.env.DING_SKU_VIVA || ""
};

// Tasa de conversión RD$ → USD para enviar a Ding (ajústala a tu criterio)
const TASA_RD_USD = Number(process.env.TASA_RD_USD || 60); // 60 RD$ = 1 USD

async function verificarAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) return res.status(401).json({ status: "error", message: "Token faltante" });
    const decoded = await admin.auth().verifyIdToken(auth.substring(7));
    const adminDoc = await db.collection("admins").doc(decoded.uid).get();
    if (!adminDoc.exists) return res.status(403).json({ status: "error", message: "No eres administrador" });
    req.adminUid = decoded.uid;
    req.adminEmail = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ status: "error", message: "Token inválido: " + e.message });
  }
}

// Verifica token de cualquier usuario (no solo admin) para la recarga
async function verificarUsuario(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) return res.status(401).json({ status: "error", message: "Token faltante" });
    const decoded = await admin.auth().verifyIdToken(auth.substring(7));
    req.uid = decoded.uid;
    req.email = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ status: "error", message: "Token inválido: " + e.message });
  }
}

app.get("/", (req, res) => res.json({ status: "ok", mensaje: "Backend GRULODE activo" }));
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ===== PROCESAR SOLICITUD =====
app.post("/procesarSolicitud", verificarAdmin, async (req, res) => {
  const { solicitudId, accion, comprobante, motivo } = req.body || {};
  if (!solicitudId || !["aprobar", "rechazar"].includes(accion)) {
    return res.status(400).json({ status: "error", message: "Datos incompletos" });
  }
  try {
    const result = await db.runTransaction(async (tx) => {
      const solRef = db.collection("solicitudes").doc(solicitudId);
      const solSnap = await tx.get(solRef);
      if (!solSnap.exists) throw new Error("Solicitud no existe");
      const sol = solSnap.data();
      if (sol.status !== "pending") throw new Error("La solicitud ya fue procesada");

      const uid = sol.uid || sol.userId || sol.user;
      if (!uid) throw new Error("La solicitud no tiene uid de usuario");

      const userRef = db.collection("usuarios").doc(String(uid));
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("Usuario no existe");
      const user = userSnap.data();
      const amount = Number(sol.amount || 0);

      if (accion === "aprobar") {
        if (sol.type === "deposit") {
          tx.update(userRef, { balance: admin.firestore.FieldValue.increment(amount) });
        } else if (sol.type === "withdraw") {
          if (Number(user.balance || 0) < amount) throw new Error("Saldo insuficiente para pagar retiro");
          tx.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });
        }
        tx.update(solRef, {
          status: "approved", approvedAt: new Date().toISOString(),
          aprobadoPor: req.adminEmail, ...(comprobante ? { comprobante } : {})
        });
      } else {
        tx.update(solRef, {
          status: "rejected", rejectedAt: new Date().toISOString(),
          motivoRechazo: motivo || "Sin motivo", aprobadoPor: req.adminEmail
        });
      }
      return { type: sol.type, amount, uid };
    });

    const detalles = { ...result };
    if (comprobante) detalles.comprobante = comprobante;
    if (motivo) detalles.motivo = motivo;

    await db.collection("audit_log").add({
      accion: `${accion}_solicitud`, targetId: solicitudId,
      adminEmail: req.adminEmail, adminUid: req.adminUid,
      detalles: detalles, createdAt: new Date().toISOString()
    });
    return res.json({ status: "ok", ...result });
  } catch (e) {
    return res.status(400).json({ status: "error", message: e.message });
  }
});

// ===== PROCESAR SORTEO =====
app.post("/procesarSorteo", verificarAdmin, async (req, res) => {
  const { loteria, numeros, fechaClave, adminEmail } = req.body || {};
  if (!loteria || !Array.isArray(numeros) || numeros.length !== 3) {
    return res.status(400).json({ status: "error", message: "Datos incompletos" });
  }
  const nums = numeros.map(n => String(n).padStart(2, "0"));
  const fecha = fechaClave || new Date().toISOString().slice(0, 10);

  try {
    const ticketsSnap = await db.collection("tickets")
      .where("lot", "==", loteria).where("fechaClave", "==", fecha).get();

    let pagados = 0, totalPagado = 0;
    const ganadores = [];

    for (const ticketDoc of ticketsSnap.docs) {
      const t = ticketDoc.data();
      const items = Array.isArray(t.items) ? t.items : [];
      let premioTicket = 0;

      for (const it of items) {
        const mode = it.mode;
        const numsJugados = (it.nums || []).map(n => String(n).padStart(2, "0"));
        const amt = Number(it.amt || 0);
        let mult = 0;

        if (mode === "Q1") {
          const n = numsJugados[0];
          if (n === nums[0]) mult = 60;
          else if (n === nums[1]) mult = 8;
          else if (n === nums[2]) mult = 4;
        } else if (mode === "P12") {
          if (numsJugados.length === 2 && numsJugados.every(n => nums.includes(n))) mult = 1000;
        } else if (mode === "T3") {
          if (numsJugados.length === 3 && numsJugados.slice().sort().join() === nums.slice().sort().join()) mult = 20000;
        }
        if (mult > 0) premioTicket += amt * mult;
      }

      if (premioTicket > 0) {
        const uid = t.uid || t.userId;
        if (uid) await db.collection("usuarios").doc(String(uid)).update({
          balance: admin.firestore.FieldValue.increment(premioTicket)
        });
        await ticketDoc.ref.update({ premio: premioTicket, status: "ganador", pagadoAt: new Date().toISOString() });
        pagados++; totalPagado += premioTicket;
        ganadores.push({ ticketId: ticketDoc.id, uid, premio: premioTicket });
      } else {
        await ticketDoc.ref.update({ premio: 0, status: "perdedor" });
      }
    }

    await db.collection("resultados_globales").add({
      loteria, nums: nums, fechaClave: fecha,
      createdAt: new Date().toISOString()
    });

    const superSnap = await db.collection("tickets")
      .where("fechaClave", "==", fecha).get();

    let superPagados = 0, superTotal = 0;

    for (const doc of superSnap.docs) {
      const t = doc.data();
      if (t.pagadoSuper) continue;
      const items = Array.isArray(t.items) ? t.items : [];

      for (const it of items) {
        if (it.mode !== "SUPER") continue;
        const lot1 = it.lot1 || it.loteria1 || it.lotA;
        const lot2 = it.lot2 || it.loteria2 || it.lotB;
        const numsIt = (it.nums || it.numeros || []).map(n => String(n).padStart(2, "0"));
        const amt = Number(it.amt || it.monto || it.amount || 0);
        if (!lot1 || !lot2 || numsIt.length !== 2 || amt <= 0) continue;

        let otraLot = null, numEsta = null, numOtra = null;
        if (lot1 === loteria) { otraLot = lot2; numEsta = numsIt[0]; numOtra = numsIt[1]; }
        else if (lot2 === loteria) { otraLot = lot1; numEsta = numsIt[1]; numOtra = numsIt[0]; }
        else continue;

        if (numEsta !== nums[0]) continue;

        const otraSnap = await db.collection("resultados_globales")
          .where("loteria", "==", otraLot).where("fechaClave", "==", fecha)
          .orderBy("createdAt", "desc").limit(1).get();

        if (otraSnap.empty) continue;
        const otraRes = otraSnap.docs[0].data();
        const otraNum = String(otraRes.nums ? otraRes.nums[0] : otraRes.numeros[0]).padStart(2, "0");

        if (numOtra === otraNum) {
          const premio = amt * 3000;
          const uid = t.uid || t.userId;
          if (uid) await db.collection("usuarios").doc(String(uid)).update({
            balance: admin.firestore.FieldValue.increment(premio)
          });
          await doc.ref.update({ pagadoSuper: true, premioSuper: premio, pagadoSuperAt: new Date().toISOString() });
          superPagados++; superTotal += premio;
        }
      }
    }

    await db.collection("audit_log").add({
      accion: "publicar_sorteo", targetId: loteria,
      adminEmail: req.adminEmail, adminUid: req.adminUid,
      detalles: { nums: nums, fechaClave: fecha, pagados, totalPagado, superPagados, superTotal },
      createdAt: new Date().toISOString()
    });

    return res.json({ status: "ok", pagados, totalPagado, ganadores, superPagados, superTotal });
  } catch (e) {
    return res.status(400).json({ status: "error", message: e.message });
  }
});

// ============================================================
// ===== NUEVA RUTA: RECARGA TELEFÓNICA CON DING =====
// ============================================================
app.post("/api/recargar", verificarUsuario, async (req, res) => {
  const { compania, telefono, monto } = req.body || {};

  // Validaciones básicas
  if (!DING_API_KEY) {
    return res.status(500).json({ status: "error", message: "DING_API_KEY no configurada en el servidor" });
  }
  if (!compania || !SKU_MAP[compania]) {
    return res.status(400).json({ status: "error", message: "Compañía inválida o sin SKU configurado" });
  }
  if (!/^\d{10}$/.test(String(telefono || ""))) {
    return res.status(400).json({ status: "error", message: "Teléfono inválido (10 dígitos)" });
  }
  const montoRD = Number(monto);
  if (!montoRD || montoRD < 50) {
    return res.status(400).json({ status: "error", message: "Monto mínimo RD$50" });
  }

  const uid = req.uid;
  const userRef = db.collection("usuarios").doc(String(uid));

  try {
    // 1) Verificar saldo y descontar de forma atómica
    await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) throw new Error("Usuario no existe");
      const bal = Number(uSnap.data().balance || 0);
      if (bal < montoRD) throw new Error("Saldo insuficiente");
      tx.update(userRef, { balance: admin.firestore.FieldValue.increment(-montoRD) });
    });

    // 2) Crear registro de recarga en estado "procesando"
    const recargaRef = db.collection("recargas_telefonicas").doc();
    await recargaRef.set({
      uid, nombreJugador: (await userRef.get()).data().nombre || "",
      telefono: String(telefono), compania,
      amount: montoRD, status: "procesando",
      createdAt: new Date().toISOString(),
      dingTransferRef: null, dingStatus: null, motivoRechazo: null
    });

    // 3) Llamar a Ding SendTransfer
    // Convertimos RD$ a USD (Ding usa USD en tu cuenta)
    const sendValueUSD = +(montoRD / TASA_RD_USD).toFixed(2);

    const dingResp = await fetch(`${DING_BASE}/api/V1/SendTransfer`, {
      method: "POST",
      headers: {
        "api_key": DING_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        SkuCode: SKU_MAP[compania],
        SendValue: sendValueUSD,
        SendCurrencyIso: "USD",
        AccountNumber: String(telefono),
        DistributorRef: recargaRef.id
      })
    });

    const data = await dingResp.json();
    const transfer = data.Transfers && data.Transfers[0];
    const dingStatus = transfer?.TransferStatus || null;
    const ok = dingStatus === "Complete" || dingStatus === "Submitted";

    if (ok) {
      await recargaRef.update({
        status: "approved",
        dingTransferRef: transfer?.TransferRef || null,
        dingStatus: dingStatus,
        approvedAt: new Date().toISOString(),
        sendValueUSD
      });
      return res.json({ status: "ok", ok: true, dingStatus, transferRef: transfer?.TransferRef || null });
    } else {
      // Reembolsar al usuario
      await userRef.update({ balance: admin.firestore.FieldValue.increment(montoRD) });
      const motivo = transfer?.Receipt?.ErrorText || data.Message || "Ding rechazó la recarga";
      await recargaRef.update({
        status: "rejected",
        dingStatus: dingStatus,
        motivoRechazo: motivo,
        rejectedAt: new Date().toISOString(),
        sendValueUSD
      });
      return res.status(400).json({ status: "error", ok: false, message: motivo, dingStatus });
    }
  } catch (e) {
    // Si falló antes de llamar a Ding, reembolsar
    try {
      await userRef.update({ balance: admin.firestore.FieldValue.increment(montoRD) });
    } catch (_) {}
    return res.status(400).json({ status: "error", ok: false, message: e.message });
  }
});

app.listen(PORT, () => console.log("✅ Backend GRULODE activo en puerto " + PORT));
