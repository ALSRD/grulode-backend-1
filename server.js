const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!serviceAccount.project_id) {
  console.error("❌ Falta FIREBASE_SERVICE_ACCOUNT en las variables de entorno");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

app.use(cors({ origin: true }));
app.use(express.json());

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

    await db.collection("audit_log").add({
      accion: `${accion}_solicitud`, targetId: solicitudId,
      adminEmail: req.adminEmail, adminUid: req.adminUid,
      detalles: { ...result, comprobante, motivo }, createdAt: new Date().toISOString()
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
    // 1. Pagar tickets normales (Q1, P12, T3) de esta lotería
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

    // 2. Guardar este resultado para que el Super Palé lo pueda consultar después
    await db.collection("resultados_globales").add({
      loteria, numeros: nums, fechaClave: fecha,
      createdAt: new Date().toISOString()
    });

    // 3. Resolver Super Palés pendientes que involucren esta lotería
    const superSnap = await db.collection("tickets")
      .where("fechaClave", "==", fecha).get();

    let superPagados = 0, superTotal = 0;

    for (const doc of superSnap.docs) {
      const t = doc.data();
      if (t.pagadoSuper) continue;
      const items = Array.isArray(t.items) ? t.items : [];

      for (const it of items) {
        if (it.mode !== "SUPER") continue;

        // Detectar campos de loterías y números de forma flexible
        const lot1 = it.lot1 || it.loteria1 || it.lotA;
        const lot2 = it.lot2 || it.loteria2 || it.lotB;
        const numsIt = (it.nums || it.numeros || []).map(n => String(n).padStart(2, "0"));
        const amt = Number(it.amt || it.monto || it.amount || 0);

        if (!lot1 || !lot2 || numsIt.length !== 2 || amt <= 0) continue;

        // Verificar si esta publicación corresponde a una de las dos loterías
        let otraLot = null, numEsta = null, numOtra = null;
        if (lot1 === loteria) { otraLot = lot2; numEsta = numsIt[0]; numOtra = numsIt[1]; }
        else if (lot2 === loteria) { otraLot = lot1; numEsta = numsIt[1]; numOtra = numsIt[0]; }
        else continue;

        // Esta lotería debe tener el número en 1ra posición
        if (numEsta !== nums[0]) continue;

        // Buscar el resultado de la otra lotería
        const otraSnap = await db.collection("resultados_globales")
          .where("loteria", "==", otraLot).where("fechaClave", "==", fecha)
          .orderBy("createdAt", "desc").limit(1).get();

        if (otraSnap.empty) continue;
        const otraRes = otraSnap.docs[0].data();

        if (numOtra === String(otraRes.numeros[0]).padStart(2, "0")) {
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
      detalles: { numeros: nums, fechaClave: fecha, pagados, totalPagado, superPagados, superTotal },
      createdAt: new Date().toISOString()
    });

    return res.json({ status: "ok", pagados, totalPagado, ganadores, superPagados, superTotal });
  } catch (e) {
    return res.status(400).json({ status: "error", message: e.message });
  }
});

app.listen(PORT, () => console.log("✅ Backend GRULODE activo en puerto " + PORT));
